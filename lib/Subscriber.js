const EventEmitter = require('events').EventEmitter;
const JsSIP_C = require('./Constants');
const Utils = require('./Utils');
const Grammar = require('./Grammar');
const debug = require('debug')('JsSIP:Subscriber');
const debugerror = require('debug')('JsSIP:ERROR:Subscriber');

debugerror.log = console.warn.bind(console);

/**
 * Termination code 
 */
const C = {
  SUBSCRIBE_RESPONSE_TIMEOUT      : 0, 
  SUBSCRIBE_TRANSPORT_ERROR       : 1, 
  SUBSCRIBE_NON_OK_RESPONSE       : 2, 
  SUBSCRIBE_FAILED_AUTHENTICATION : 3,
  SEND_UNSUBSCRIBE                : 4, 
  RECEIVE_FINAL_NOTIFY            : 5,
  RECEIVE_BAD_NOTIFY              : 6 
};

/**
 * It's implementation of RFC 6665 Subscriber
 */
module.exports = class Subscriber extends EventEmitter 
{
  /**
   * Expose C object.
   */
  static get C()
  {
    return C;
  }

  get C()
  {
    return C;
  }

  /**
   * -param {Object} ua reference to JsSIP.UA
   * -param {String} target
   * -param {Object} options 
   *   -param {String} event_name Event header value. May end with optional ;id=xxx
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

    const parsed = Grammar.parse(event_name, 'Event');

    if (parsed === -1)
    {
      throw new TypeError('event_name - wrong format');
    }
    
    this.event_name = parsed.event;
    this.event_id = parsed.params && parsed.params.id;

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

    this.params = Utils.cloneObject(params);

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
    
    this.headers = Utils.cloneArray(headers);
    let event_value = this.event_name;

    if (this.event_id)
    {
      event_value += `;id=${this.event_id}`;
    }
    
    this.headers = this.headers.concat([
      `Event: ${event_value}`,
      `Expires: ${this.expires}`,
      `Accept: ${this.accept}`, 
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
    this._dialogTerminated(C.SUBSCRIBE_RESPONSE_TIMEOUT);
  }

  onTransportError() 
  {
    this._dialogTerminated(C.SUBSCRIBE_TRANSPORT_ERROR);
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
    else if (response.status_code === 401 || response.status_code === 407)
    {
      this._dialogTerminated(C.SUBSCRIBE_FAILED_AUTHENTICATION);
    }
    else if (response.status_code >= 300) 
    {
      this._dialogTerminated(C.SUBSCRIBE_NON_OK_RESPONSE);
    }
  }

  /**
   * Dialog callback
   */
  receiveRequest(request) 
  {
    if (request.method !== JsSIP_C.NOTIFY) 
    {
      debugerror('received non-NOTIFY request');
      request.reply(405);  

      return;
    }

    // RFC 6665 8.2.1. Check if event header matches
    const event_header = request.parseHeader('Event');

    if (!event_header) 
    {
      debugerror('missed Event header');
      request.reply(400);
      this._dialogTerminated(C.RECEIVE_BAD_NOTIFY);

      return;
    }

    const event_name = event_header.event;
    const event_id = event_header.params && event_header.params.id;

    if (event_name !== this.event_name || event_id !== this.event_id)
    {
      debugerror('Event header does not match SUBSCRIBE');
      request.reply(489);
      this._dialogTerminated(C.RECEIVE_BAD_NOTIFY);

      return;
    }

    // Process Subscription-State header
    const subs_state = request.parseHeader('subscription-state');

    if (!subs_state) 
    {
      debugerror('missed Subscription-State header');
      request.reply(400);
      this._dialogTerminated(C.RECEIVE_BAD_NOTIFY);

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
      this._dialogTerminated(C.RECEIVE_FINAL_NOTIFY);
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

    // Set header Expires: 0
    const headers = this.headers.map((s) => 
    { 
      return s.startsWith('Expires') ? 'Expires: 0' : s; 
    });

    this._send(body, headers);
    this._dialogTerminated(C.SEND_UNSUBSCRIBE);
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
  _dialogTerminated(termination_code) 
  {
    // to prevent duplicate emit terminated
    if (this.is_terminated) 
    {
      return;
    }

    this.is_terminated = true;
    this._state = 'terminated';
    clearTimeout(this.expires_timer);

    // remove dialog with some delay to receiving possible final NOTIFY
    if (this.id)
    {
      setTimeout(() => 
      {
        debug('removed dialog id=', this.id);

        this._ua.destroyDialog(this);
      }, 32000);
    }

    debug(`emit "terminated" termination code=${termination_code}"`);
    this.emit('terminated', termination_code);
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