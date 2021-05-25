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
 * It's implementation of RFC 6665 Notifier
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
   *   -param {String} content_type Content-Type header value
   *   -param {Array}  headers Optional. Additional SIP headers.
   *   -param {String} allow_events Allow-Events header value. Optional.
   *   -param {Object} credential. Will have priority over ua.configuration. Optional.
   *   -param {Boolean} pending Set initial dialog state as "pending". Optional. 
   */
  constructor(ua, { subscribe, content_type, headers, allow_events,
    credential, pending }) 
  {
    debug('new');

    super();

    this._ua = ua;
    this._expires_timestamp = null;
    this._expires_timer = null;
    this._state = pending ? 'pending' : 'active';
    this._is_final_notify_sent = false;
    this._is_first_notify_response = true;
    this._id = null;
    this._allow_events = allow_events;
    this._event_name = subscribe.getHeader('event');

    if (!content_type)
    {
      throw new TypeError('content_type is undefined');
    }

    this._content_type = content_type;
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

    // Dialog id
    this._id = `${this._params.call_id}${this._params.from_tag}${this._params.to_tag}`;

    debug('add dialog id=', this._id);
    this._ua.newDialog(this);

    // Set expires timer and timestamp
    this._setExpiresTimer();

    this._is_terminated = false;
    this._terminated_reason = undefined;

    // Custom session empty object for high level use.
    this.data = {};

    subscribe.reply(200, null, [ `Expires: ${this._expires}`, `Contact: ${this._contact}` ]);
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
   * Dialog callback
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

    debug('emit "subscribe"');
    this.emit('subscribe', is_unsubscribe, request, body, content_type);

    if (is_unsubscribe) 
    {
      this._dialogTerminated(C.RECEIVE_UNSUBSCRIBE);
    } 
    else 
    {
      this._setExpiresTimer();
    }
  }

  /**
   * User API
   */

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
    else if (this._terminated_reason) 
    {
      subs_state += `;reason=${this._terminated_reason}`;
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
   * -param {String} reason To construct Subscription-State. Optional.
   */
  sendFinalNotify(body = null, reason = null) 
  {
    debug('sendFinalNotify()');
    
    if (this._is_final_notify_sent)
    {
      return;
    }

    this._is_final_notify_sent = true;
    this._dialogTerminated(C.SEND_FINAL_NOTIFY);
    this._terminated_reason = reason;
    this.sendNotify(body);
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

    const send_final_notify = (termination_code === C.RECEIVE_UNSUBSCRIBE 
      || termination_code === C.SUBSCRIPTION_EXPIRED);
  
    debug(`emit "terminated" termination code=${termination_code}, send final notify=${send_final_notify}`);
    this.emit('terminated', termination_code, send_final_notify);
  }

  _setExpiresTimer() 
  {
    this._expires_timestamp = new Date().getTime() + (this._expires * 1000);

    clearTimeout(this._expires_timer);
    setTimeout(() => 
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