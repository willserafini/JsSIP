const EventEmitter = require('events').EventEmitter;
const JsSIP_C = require('./Constants');
const Utils = require('./Utils');
const debug = require('debug')('JsSIP:Notifier');
const debugerror = require('debug')('JsSIP:ERROR:Notifier');

debugerror.log = console.warn.bind(console);

/**
 * Termination code 
 */
const C = {
  NOTIFY_RESPONSE_TIMEOUT      : 0, 
  NOTIFY_TRANSPORT_ERROR       : 1, 
  NOTIFY_NON_OK_RESPONSE       : 2, 
  NOTIFY_FAILED_AUTHENTICATION : 3,
  SEND_FINAL_NOTIFY            : 4, 
  RECEIVE_UNSUBSCRIBE          : 5, 
  SUBSCRIPTION_EXPIRED         : 6  
};

/**
 * RFC 6665 Notifier implementation.
 */
module.exports = class Notifier extends EventEmitter 
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
   * -param {Object} ua JsSIP UA
   * -param {Object} options 
   *   -param {IncomingRequest} subscribe
   *   -param {String} contentType Content-Type header value
   *   -param {Array}  headers Optional. Additional SIP headers.
   *   -param {String} allowEvents Allow-Events header value. Optional.
   *   -param {Object} credential. Will have priority over ua.configuration. Optional.
   *   -param {Boolean} pending Set initial dialog state as "pending". Optional. 
   */
  constructor(ua, { subscribe, contentType, headers, allowEvents,
    credential, pending }) 
  {
    debug('new');

    super();

    this._ua = ua;
    this._initial_subscribe = subscribe;
    this._expires_timestamp = null;
    this._expires_timer = null;

    // Notifier state: pending, active, terminated. Not used: init, resp_wait
    this._state = pending ? 'pending' : 'active';
    this._is_final_notify_sent = false;
    this._is_first_notify_response = true;

    // dialog id
    this._id = null;
    this._allow_events = allowEvents;
    this._event_name = subscribe.getHeader('event');

    if (!contentType)
    {
      throw new TypeError('contentType is undefined');
    }

    this._content_type = contentType;
    this._expires = parseInt(subscribe.getHeader('expires'));
    this._credential = credential;
    this._contact = `<sip:${subscribe.to.uri.user}@${Utils.createRandomToken(12)}.invalid;transport=ws>`;
    this._headers = Utils.cloneArray(headers);
    this._headers.push(`Event: ${this._event_name}`);
    this._headers.push(`Contact: ${this._contact}`);

    if (this._allow_events)
    {
      this._headers.push(`Allow-Events: ${this._allow_events}`);
    }

    this._target = subscribe.from.uri.user;
    subscribe.to_tag = Utils.newTag();

    // NOTIFY request params set according received SUBSCRIBE
    this._params = {
      from     : subscribe.to,
      from_tag : subscribe.to_tag,
      to       : subscribe.from,
      to_tag   : subscribe.from_tag,
      call_id  : subscribe.call_id,
      cseq     : Math.floor((Math.random() * 10000) + 1)
    };

    // For non-fetch subscribe add dialog
    if (this._expires > 0)
    {
      // Dialog id
      this._id = `${this._params.call_id}${this._params.from_tag}${this._params.to_tag}`;

      debug('add dialog id=', this._id);
      this._ua.newDialog(this);

      // Set expires timer and timestamp
      this._setExpiresTimer();
    }

    // To prevent duplicate emit 'terminated'
    this._is_terminated = false;

    // Optional. Used to build terminated Subscription-State
    this._terminated_reason = null;
    this._terminated_retry_after = null;

    // Custom session empty object for high level use.
    this.data = {};
  }

  /**
   * NOTIFY transactions callbacks
   */
  onAuthenticated() 
  {
    this._params.cseq++;
  }

  onRequestTimeout() 
  {
    this._dialogTerminated(C.NOTIFY_RESPONSE_TIMEOUT);
  }

  onTransportError() 
  {
    this._dialogTerminated(C.NOTIFY_TRANSPORT_ERROR);
  }

  onReceiveResponse(response) 
  {
    if (response.status_code >= 200 && response.status_code < 300) 
    {
      if (this._is_first_notify_response) 
      {
        this._is_first_notify_response = false;
        
        const route_set = response.getHeaders('record-route').reverse();

        if (route_set.length > 0)
        {
          this._params.route_set = route_set;
        }
      }
    } 
    else if (response.status_code === 401 || response.status_code === 407)
    {
      this._dialogTerminated(C.NOTIFY_FAILED_AUTHENTICATION);
    }
    else if (response.status_code >= 300) 
    {
      this._dialogTerminated(C.NOTIFY_NON_OK_RESPONSE);
    }
  }

  /**
   * Dialog callback.
   * Called also for initial subscribe 
   * Supported RFC 6665 4.4.3: initial fetch subscribe (with expires: 0) 
   */
  receiveRequest(request) 
  {
    if (request.method !== JsSIP_C.SUBSCRIBE) 
    {
      request.reply(405);   

      return;
    }

    let h = request.getHeader('expires');

    if (h === undefined || h === null) 
    { 
      // Missed header Expires. RFC 6665 3.1.1. Set default expires value  
      h = '900';
      debug(`Missed expires header. Set by default ${h}`);
    }

    this._expires = parseInt(h);
    request.reply(200, null, [ `Expires: ${this._expires}`, `Contact: ${this._contact}` ]);

    const body = request.body;
    const content_type = request.getHeader('content-type');
    const is_unsubscribe = this._expires === 0;

    if (!is_unsubscribe)
    {
      this._setExpiresTimer();
    }

    debug('emit "subscribe"');
    this.emit('subscribe', is_unsubscribe, request, body, content_type);

    if (is_unsubscribe) 
    {
      this._dialogTerminated(C.RECEIVE_UNSUBSCRIBE);
    } 
  }

  /**
   * User API
   */

  /**
   * Should be called after creating the Notifier instance and setting the event handlers
   */
  start()
  {  
    debug('start()');

    this.receiveRequest(this._initial_subscribe);
  }

  /**
   * Switch pending dialog state to active
   */
  setActiveState() 
  {
    debug('setActiveState()');

    if (this._state === 'pending') 
    {
      this._state = 'active';
    }
  }
 
  /**
   *  Send the initial and subsequent NOTIFY request
   * -param {String} body. Optional.
   */
  sendNotify(body = null) 
  {
    debug('sendNotify()');

    // Prevent send notify after final notify
    if (this._is_final_notify_sent)
    {
      debugerror('final notify has sent');

      return;
    }

    let subs_state = this._state;
 
    if (this._state !== 'terminated') 
    {
      let expires = Math.floor((this._expires_timestamp - new Date().getTime()) / 1000);

      if (expires < 0)
      {
        expires = 0;
      }

      subs_state += `;expires=${expires}`;
    } 
    else 
    {
      if (this._terminated_reason) 
      {
        subs_state += `;reason=${this._terminated_reason}`;
      }
      if (this._terminated_retry_after !== null)
      {
        subs_state += `;retry-after=${this._terminated_retry_after}`;    
      }
    }

    const headers = this._headers.slice();

    headers.push(`Subscription-State: ${subs_state}`);

    if (body) 
    {
      headers.push(`Content-Type: ${this._content_type}`);
    }

    this._params.cseq++;
    this._ua.sendRequest(JsSIP_C.NOTIFY, this._target, this._params, headers, body,
      this, this._credential);
  }

  /**
   *  Send the final NOTIFY request
   * -param {String} body Optional.
   * -param {String} reason Optional. To build Subscription-State header
   * -param {Number} retryAfter Optional. To build Subscription-State header
   */
  sendFinalNotify(body = null, reason = null, retryAfter = null) 
  {
    debug('sendFinalNotify()');
    
    this._state = 'terminated';
    this._terminated_reason = reason;
    this._terminated_retry_after = retryAfter;

    this.sendNotify(body);

    this._is_final_notify_sent = true;
    this._dialogTerminated(C.SEND_FINAL_NOTIFY);
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
  _dialogTerminated(termination_code) 
  { 
    if (this._is_terminated)
    {
      return;
    }

    this._is_terminated = true;
    this._state = 'terminated';
    clearTimeout(this._expires_timer);

    if (this._id)
    {
      debug('remove dialog id=', this._id);
      this._ua.destroyDialog(this);
    }

    const send_final_notify = termination_code === C.SUBSCRIPTION_EXPIRED;
  
    debug(`emit "terminated" code=${termination_code}, send final notify=${send_final_notify}`);
    this.emit('terminated', termination_code, send_final_notify);
  }

  _setExpiresTimer() 
  {
    this._expires_timestamp = new Date().getTime() + (this._expires * 1000);

    clearTimeout(this._expires_timer);
    this._expires_timer = setTimeout(() => 
    {
      if (this._is_final_notify_sent)
      {
        return;
      }

      this._terminated_reason = 'timeout';
      this._is_final_notify_sent = true;
      this.sendNotify();
      this._dialogTerminated(C.SUBSCRIPTION_EXPIRED);
    }, this._expires * 1000);
  }
};
