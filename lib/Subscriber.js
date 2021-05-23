const EventEmitter = require('events').EventEmitter;
const JsSIP_C = require('./Constants');
const Utils = require('./Utils');
const debug = require('debug')('JsSIP:Subscriber');
const debugerror = require('debug')('JsSIP:ERROR:Subscriber');

debugerror.log = console.warn.bind(console);

/**
 * It's implementation of RFC 6665 Subscriber
 */
module.exports = class Subscriber extends EventEmitter 
{
  /**
   * -param {Object} ua JsSIP UA
   * -param {String} target
   * -param {Object} options 
   *   -param {String} event_name Event header value
   *   -param {String} accept Accept header value
   *   -param {Number} expires Expires header value. Optional. Default is 900
   *   -param {String} content_type Content-Type header value
   *   -param {String} allow_events Allow-Events header value. Optional.
   *   -param {Object} params Will have priority over ua.configuration. Optional.
   *      If set please define: to_uri, to_display_name, from_uri, from_display_name
   *   -param {Array}  headers Optional. Additional SIP headers.
   *   -param {Object} credential. Will have priority over ua.configuration. Optional.
   */
  constructor(ua, target, { event_name, accept, expires, content_type, 
    allow_events, params, headers, credential }) 
  {
    debug('new');

    super();

    this._ua = ua;

    if (!target)
    {
      throw new TypeError('target is undefined');
    }

    this.target = target;

    if (!event_name)
    {
      throw new TypeError('event_name is undefined');
    }

    this.event_name = event_name;
    
    if (!accept)
    {
      throw new TypeError('accept is undefined');
    }

    this.accept = accept;
    
    if (!expires)
    {
      expires = 900;
    }

    this.expires = expires;
    this.allow_events = allow_events;

    // used to subscribe with body
    this.content_type = content_type; 
    this.is_first_notify_request = true;

    this.params = params ? Utils.cloneObject(params) : {};

    if (!this.params.from_uri)
    {
      this.params.from_uri = this._ua.configuration.uri;
    }

    // set SUBSCRIBE dialog parameters
    this.params.from_tag = Utils.newTag();
    this.params.to_tag = null;
    this.params.call_id = Utils.createRandomToken(20);
    this.params.cseq = Math.floor((Math.random() * 10000) + 1);

    // Create contact
    this.contact = `<sip:${this.params.from_uri.user}@${Utils.createRandomToken(12)}.invalid;transport=ws>`;
    this.contact += `;+sip.instance="<urn:uuid:${this._ua.configuration.instance_id}>"`;
    
    // Optional, used if credential is different from REGISTER/INVITE
    this.credential = credential; 

    // Dialog state: init, notify_wait, pending, active, terminated
    this._state = 'init';

    // Dialog id 
    this.id = null;

    // To refresh subscription
    this.expires_timer = null;
    this.expires_timestamp = null;      
    
    if (!headers)
    {
      headers = [];
    }

    this.headers = headers.concat([
      `Event: ${this.event_name}`,
      `Accept: ${this.accept}`, 
      `Expires: ${this.expires}`,
      `Contact: ${this.contact}`
    ]);

    if (this.allow_events)
    {
      this.headers.push(`Allow-Events: ${this.allow_events}`);
    }

    this.is_terminated = false;
    this.route_set = null;

    // Custom session empty object for high level use.    
    this.data = {};
  }

  /**
   * SUBSCRIBE transactions callbacks
   */
  onAuthenticated() 
  {
    this.params.cseq++;
  }

  onRequestTimeout() 
  {
    this._dialogTerminated('subscribe response timeout');
  }

  onTransportError() 
  {
    this._dialogTerminated('subscribe transport error');
  }

  onReceiveResponse(response) 
  {
    if (response.status_code >= 200 && response.status_code < 300) 
    {
      if (this.params.to_tag === null) 
      {
        this.params.to_tag = response.to_tag;
        this.id = `${this.params.call_id}${this.params.from_tag}${this.params.to_tag}`;

        debug('added dialog id=', this.id);
        this._ua.newDialog(this);

        this.route_set = response.getHeaders('record-route').reverse();

        if (this.route_set.length > 0)
        {
          this.params.route_set = this.route_set;
        }
      }
      const expires = this._getExpires(response);

      if (expires === -1) 
      {
        debugerror('response without Expires header');

        return;
      }

      if (expires > 0) 
      {
        this.expires_timestamp = new Date().getTime() + (expires * 1000);
        this._scheduleSubscribe(this._calculateTimeoutMs(expires));
      }
    } 
    else if (response.status_code >= 300) 
    {
      this._dialogTerminated('receive subscribe non-OK response');
    }
  }

  /**
   * Dialog callback
   */
  receiveRequest(request) 
  {
    if (request.method !== JsSIP_C.NOTIFY) 
    {
      request.reply(405);  

      return;
    }

    const subs_state = request.parseHeader('subscription-state');

    if (!subs_state) 
    {
      debugerror('missed header Subscription-State');
      request.reply(400);

      return;
    }

    request.reply(200);

    if (this.is_first_notify_request)
    {
      this.is_first_notify_request = false;
      // TODO: see RFC 6665 4.4.1. If route_set should be updated here ?
    }

    const new_state = subs_state.state.toLowerCase();
    const prev_state = this._state;
 
    if (prev_state !== 'terminated' && new_state !== 'terminated') 
    {
      this._state = new_state;

      if (subs_state.expires !== undefined) 
      {
        const expires = subs_state.expires;
        const expires_timestamp = new Date().getTime() + (expires * 1000);
        const max_time_deviation = 2000;

        // expiration time is shorter and the difference is not too small
        if (this.expires_timestamp - expires_timestamp > max_time_deviation) 
        {
          debug('update sending re-SUBSCRIBE time');

          clearTimeout(this.expires_timer);
          this.expires_timestamp = expires_timestamp;
          this._scheduleSubscribe(this._calculateTimeoutMs(expires));
        }
      }
    }

    if (prev_state !== 'active' && new_state === 'active') 
    {
      debug('emit "active"');
      this.emit('active');
    }

    const body = request.body;
    const is_final = new_state === 'terminated';

    // notify event fired for NOTIFY with body
    if (body) 
    {
      const content_type = request.getHeader('content-type');

      debug('emit "notify"');
      this.emit('notify', is_final, request, body, content_type);
    }

    if (is_final)
    {
      this._dialogTerminated('receive final notify');
    }
  }

  /**
   * User API
   */

  /** 
   * Send the initial and subsequent SUBSCRIBE request
   * -param {String} body. Optional.
   */
  subscribe(body = null) 
  {
    debug('subscribe()');

    if (this._state === 'init')
    {
      this._state = 'notify_wait';
    }
    const headers = this.headers.slice();

    if (body) 
    {
      if (!this.content_type)
      { 
        throw new TypeError('content_type is undefined');
      }
      headers.push(`Content-Type: ${this.content_type}`);
    }

    this._send(body, headers);
  }

  /** 
   * Send un-SUBSCRIBE
   * -param {String} body. Optional.
   */
  unsubscribe(body = null) 
  {
    debug('unsubscribe()');

    this._dialogTerminated('send un-subscribe');
    const headers = [
      `Event: ${this.event_name}`,
      'Expires: 0'
    ];

    this._send(body, headers);
  }

  /**
   * Get dialog state
   */
  get state()
  {
    return this._state;
  }

  /**
   * Private API.
   */
  _dialogTerminated(reason) 
  {
    // to prevent duplicate emit terminated
    if (this.is_terminated) 
    {
      return;
    }

    this.is_terminated = true;
    this._state = 'terminated';
    clearTimeout(this.expires_timer);

    // remove dialog from dialogs table with some delay, to allow receiving final NOTIFY
    setTimeout(() => 
    {
      debug('removed dialog id=', this.id);

      this._ua.destroyDialog(this);
    }, 32000);

    debug(`emit "terminated" ${reason}"`);
    this.emit('terminated', reason);
  }

  _send(body, headers) 
  {
    this.params.cseq++;
    this._ua.sendRequest(JsSIP_C.SUBSCRIBE, this.target, this.params, headers, 
      body, this, this.credential);
  }

  _getExpires(r) 
  {
    const e = r.getHeader('expires');

    return e ? parseInt(e) : -1;
  }

  _calculateTimeoutMs(expires) 
  {
    return expires >= 140 ? (expires * 1000 / 2) 
     + Math.floor(((expires / 2) - 70) * 1000 * Math.random()) : (expires * 1000) - 5000;
  }

  _scheduleSubscribe(timeout) 
  {
    debug(`next SUBSCRIBE will be sent in ${Math.floor(timeout / 1000)} sec`);

    this.expires_timer = setTimeout(() => 
    {
      this.expires_timer = undefined;
      this._send(null, this.headers);
    }, timeout);
  }
};