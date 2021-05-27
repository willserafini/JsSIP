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
  UNSUBSCRIBE_TIMEOUT             : 4, 
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
   *   -param {String} eventName Event header value. May end with optional ;id=xxx
   *   -param {String} accept Accept header value
   *   -param {Number} expires Expires header value. Optional. Default is 900
   *   -param {String} contentType Content-Type header value
   *   -param {String} allowEvents Allow-Events header value. Optional.
   *   -param {Object} params Will have priority over ua.configuration. Optional.
   *      If set please define: to_uri, to_display_name, from_uri, from_display_name
   *   -param {Array}  headers Optional. Additional SIP headers.
   *   -param {Object} credential. Will have priority over ua.configuration. Optional.
   */
  constructor(ua, target, { eventName, accept, expires, contentType, 
    allowEvents, params, headers, credential }) 
  {
    debug('new');

    super();

    this._ua = ua;

    if (!target)
    {
      throw new TypeError('target is undefined');
    }

    this._target = target;

    if (!eventName)
    {
      throw new TypeError('eventName is undefined');
    }

    const parsed = Grammar.parse(eventName, 'Event');

    if (parsed === -1)
    {
      throw new TypeError('eventName - wrong format');
    }
    
    this._event_name = parsed.event;
    this._event_id = parsed.params && parsed.params.id;

    if (!accept)
    {
      throw new TypeError('accept is undefined');
    }

    this._accept = accept;
    
    if (expires !== 0 && !expires)
    {
      expires = 900;
    }

    this._expires = expires;
    this._allow_events = allowEvents;

    // used to subscribe with body
    this._content_type = contentType; 

    this._is_first_notify_request = true;

    this._params = Utils.cloneObject(params);

    if (!this._params.from_uri)
    {
      this._params.from_uri = this._ua.configuration.uri;
    }

    // set SUBSCRIBE dialog parameters
    this._params.from_tag = Utils.newTag();
    this._params.to_tag = null;
    this._params.call_id = Utils.createRandomToken(20);
    this._params.cseq = Math.floor((Math.random() * 10000) + 1);

    // Create contact
    this._contact = `<sip:${this._params.from_uri.user}@${Utils.createRandomToken(12)}.invalid;transport=ws>`;
    this._contact += `;+sip.instance="<urn:uuid:${this._ua.configuration.instance_id}>"`;
    
    // Optional, used if credential is different from REGISTER/INVITE
    this._credential = credential; 

    // Dialog state: init, notify_wait, pending, active, terminated
    this._state = 'init';

    // Dialog id 
    this._id = null;

    // To refresh subscription
    this._expires_timer = null;
    this._expires_timestamp = null;
    
    // To prvent duplicate un-SUBSCRIBE sending.
    this._send_unsubscribe = false;

    // After send un-subscribe wait final NOTIFY limited time.
    this._unsubscribe_timeout_timer = null;
    
    this._headers = Utils.cloneArray(headers);
    let event_value = this._event_name;

    if (this._event_id)
    {
      event_value += `;id=${this._event_id}`;
    }
    
    this._headers = this._headers.concat([
      `Event: ${event_value}`,
      `Expires: ${this._expires}`,
      `Accept: ${this._accept}`, 
      `Contact: ${this._contact}`
    ]);

    if (this._allow_events)
    {
      this._headers.push(`Allow-Events: ${this._allow_events}`);
    }

    this._is_terminated = false;

    // Custom session empty object for high level use.    
    this.data = {};
  }

  /**
   * SUBSCRIBE transactions callbacks
   */
  onAuthenticated() 
  {
    this._params.cseq++;
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
      // add dialog to stack dialogs table
      if (this._params.to_tag === null) 
      {
        this._params.to_tag = response.to_tag;
        this._id = `${this._params.call_id}${this._params.from_tag}${this._params.to_tag}`;

        debug('added dialog id=', this._id);
        this._ua.newDialog(this);

        const route_set = response.getHeaders('record-route').reverse();
  
        if (route_set.length > 0)
        {
          this._params.route_set = route_set;
        }
      }

      // check expires value
      let expires_value = response.getHeader('expires');

      if (expires_value !== 0 && !expires_value)
      {
        debugerror('response without Expires header');

        // RFC 6665 3.1.1 SUBSCRIBE OK must contain Expires header
        // Use workaround expires value.
        expires_value = '900';
      }

      const expires = parseInt(expires_value);

      if (expires > 0)
      {
        this._scheduleSubscribe(expires);
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

    if (event_name !== this._event_name || event_id !== this._event_id)
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

    if (this._is_first_notify_request)
    {
      this._is_first_notify_request = false;
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
        if (this._expires_timestamp - expires_timestamp > max_time_deviation) 
        {
          debug('update sending re-SUBSCRIBE time');

          this._scheduleSubscribe(expires);
        }
      }
    }

    if (prev_state !== 'active' && new_state === 'active') 
    {
      debug('emit "active"');
      this.emit('active');
    }

    const body = request.body;

    // Check if the NOTIFY is final
    // For final NOTIFY get optional Subscription-State reason
    let is_final;
    let reason;

    if (new_state === 'terminated')
    {
      is_final = true;
      reason = undefined;
    }
    else 
    {
      is_final = false;
      reason = subs_state.reason;
    }

    // notify event fired for NOTIFY with body
    if (body) 
    {
      const content_type = request.getHeader('content-type');

      debug('emit "notify"');
      this.emit('notify', is_final, request, body, content_type);
    }

    if (is_final)
    {
      this._dialogTerminated(C.RECEIVE_FINAL_NOTIFY, reason);
    }
  }

  /**
   * User API
   */

  /** 
   * Send the initial (non-fetch)  and subsequent SUBSCRIBE
   * -param {String} body. Optional.
   */
  subscribe(body = null) 
  {
    debug('subscribe()');

    if (this._state === 'init')
    {
      this._state = 'notify_wait';
    }
    const headers = this._headers.slice();

    if (body) 
    {
      if (!this._content_type)
      { 
        throw new TypeError('content_type is undefined');
      }
      headers.push(`Content-Type: ${this._content_type}`);
    }

    this._send(body, headers);
  }

  /** 
   * Send un-SUBSCRIBE or fetch-SUBSCRIBE (with Expires: 0)
   * -param {String} body. Optional.
   */
  unsubscribe(body = null) 
  {
    debug('unsubscribe()');

    // Prevent duplication unsubscribe.
    if (this._send_unsubscribe)
    {
      debugerror('unsubscribe has already been sent');

      return;
    }
    this._send_unsubscribe = true;

    // Set header Expires: 0
    const headers = this._headers.map((s) => 
    { 
      return s.startsWith('Expires') ? 'Expires: 0' : s; 
    });

    this._send(body, headers);

    // Waiting for the final notify for a while
    const final_notify_timeout = 30000;

    this._unsubscribe_timeout_timer = setTimeout(() => 
    {
      this._dialogTerminated(C.UNSUBSCRIBE_TIMEOUT);
    }, final_notify_timeout);
  }

  /**
   * Get dialog state
   */
  get state()
  {
    return this._state;
  }
  
  /**
   * Get dialog id
   */
  get id()
  {
    return this._id;
  }

  /**
   * Private API.
   */
  _dialogTerminated(terminationCode, reason = undefined) 
  {
    // to prevent duplicate emit terminated
    if (this._is_terminated) 
    {
      return;
    }

    this._is_terminated = true;
    this._state = 'terminated';

    // clear timers
    clearTimeout(this._expires_timer);
    clearTimeout(this._unsubscribe_timeout_timer);

    if (this._id)
    {
      debug('removed dialog id=', this.id);
      this._ua.destroyDialog(this);
    }

    debug(`emit "terminated" code=${terminationCode} ${reason}`);
    this.emit('terminated', terminationCode, reason);
  }

  _send(body, headers) 
  {
    this._params.cseq++;
    this._ua.sendRequest(JsSIP_C.SUBSCRIBE, this._target, this._params, headers, 
      body, this, this._credential);
  }

  _scheduleSubscribe(expires) 
  {
    const timeout = expires >= 140 ? (expires * 1000 / 2) 
     + Math.floor(((expires / 2) - 70) * 1000 * Math.random()) : (expires * 1000) - 5000;

    this._expires_timestamp = new Date().getTime() + (expires * 1000);

    debug(`next SUBSCRIBE will be sent in ${Math.floor(timeout / 1000)} sec`);

    clearTimeout(this._expires_timer);
    this._expires_timer = setTimeout(() => 
    {
      this._expires_timer = null;
      this._send(null, this._headers);
    }, timeout);
  }
};