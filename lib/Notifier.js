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
  NOTIFY_RESPONSE_TIMEOUT : 0, 
  NOTIFY_TRANSPORT_ERROR  : 1, 
  NOTIFY_NON_OK_RESPONSE  : 2, 
  SEND_FINAL_NOTIFY       : 3, 
  RECEIVE_UNSUBSCRIBE     : 4, 
  SUBSCRIPTION_EXPIRED    : 5  
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
    this.expires_timestamp = null;
    this.expires_timer = null;
    this._state = pending ? 'pending' : 'active';
    this.is_final_notify_sent = false;
    this.is_first_notify_response = true;
    this.id = null;
    this.allow_events = allow_events;
    this.event_name = subscribe.getHeader('event');

    if (!content_type)
    {
      throw new TypeError('content_type is undefined');
    }

    this.content_type = content_type;
    this.expires = parseInt(subscribe.getHeader('expires'));
    this.credential = credential;
    this.contact = `<sip:${subscribe.to.uri.user}@${Utils.createRandomToken(12)}.invalid;transport=ws>`;
    this.rcseq = subscribe.cseq;

    this.headers = Utils.cloneArray(headers);
    this.headers.push(`Event: ${this.event_name}`);
    this.headers.push(`Contact: ${this.contact}`);

    if (this.allow_events)
    {
      this.headers.push(`Allow-Events: ${this.allow_events}`);
    }

    this.target = subscribe.from.uri.user;
    subscribe.to_tag = Utils.newTag();

    // NOTIFY request params set according received SUBSCRIBE
    this.params = {
      from     : subscribe.to,
      from_tag : subscribe.to_tag,
      to       : subscribe.from,
      to_tag   : subscribe.from_tag,
      call_id  : subscribe.call_id,
      cseq     : Math.floor((Math.random() * 10000) + 1)
    };

    // Dialog id
    this.id = `${this.params.call_id}${this.params.from_tag}${this.params.to_tag}`;

    debug('add dialog id=', this.id);
    this._ua.newDialog(this);

    // Set expires time-stamp and timer
    this._setExpiresTimestamp();
    this._setExpiresTimer();

    this.is_terminated = false;
    this.terminated_reason = undefined;

    // Custom session empty object for high level use.
    this.data = {};

    subscribe.reply(200, null, [ `Expires: ${this.expires}`, `Contact: ${this.contact}` ]);
  }

  /**
   * NOTIFY transactions callbacks
   */
  onAuthenticated() 
  {
    this.params.cseq++;
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
      if (this.is_first_notify_response) 
      {
        this.is_first_notify_response = false;
        this.route_set = response.getHeaders('record-route').reverse();

        if (this.route_set.length > 0)
        {
          this.params.route_set = this.route_set;
        }
      }
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

    this.expires = parseInt(h);
    request.reply(200, null, [ `Expires: ${this.expires}`, `Contact: ${this.contact}` ]);

    const body = request.body;
    const content_type = request.getHeader('content-type');
    const is_unsubscribe = this.expires === 0;

    debug('emit "subscribe"');
    this.emit('subscribe', is_unsubscribe, request, body, content_type);

    if (is_unsubscribe) 
    {
      this._dialogTerminated(C.RECEIVE_UNSUBSCRIBE);
    } 
    else 
    {
      this._setExpiresTimestamp();
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
      subs_state += `;expires=${this._getExpiresTimestamp()}`;
    } 
    else if (this.terminated_reason) 
    {
      subs_state += `;reason=${this.terminated_reason}`;
    }
 
    const headers = this.headers.slice();

    headers.push(`Subscription-State: ${subs_state}`);

    if (body) 
    {
      headers.push(`Content-Type: ${this.content_type}`);
    }

    this.params.cseq++;
    this._ua.sendRequest(JsSIP_C.NOTIFY, this.target, this.params, headers, body,
      this, this.credential);
  }

  /**
   *  Send the final NOTIFY request
   * -param {String} body Optional.
   * -param {String} reason To construct Subscription-State. Optional.
   */
  sendFinalNotify(body = null, reason = null) 
  {
    debug('sendFinalNotify()');
    
    if (this.is_final_notify_sent)
    {
      return;
    }

    this.is_final_notify_sent = true;
    this._dialogTerminated('send final notify');
    this.terminated_reason = reason;
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
   * Private API.
   */
  _dialogTerminated(termination_code) 
  { 
    if (this.is_terminated)
    {
      return;
    }

    this.is_terminated = true;
    this._state = 'terminated';
    clearTimeout(this.expires_timer);

    if (this.id)
    {
      debug('remove dialog id=', this.id);
      this._ua.destroyDialog(this);
    }

    const send_final_notify = (termination_code === C.RECEIVE_UNSUBSCRIBE 
      || termination_code === C.SUBSCRIPTION_EXPIRED);
  
    debug(`emit "terminated" termination code=${termination_code}, send final notify=${send_final_notify}`);
    this.emit('terminated', termination_code, send_final_notify);
  }

  _setExpiresTimestamp() 
  {
    this.expires_timestamp = new Date().getTime() + (this.expires * 1000);
  }

  _getExpiresTimestamp() 
  {
    const delta = Math.floor((this.expires_timestamp - new Date().getTime()) / 1000);

    return delta >= 0 ? delta : 0;
  }

  _setExpiresTimer() 
  {
    clearTimeout(this.expires_timer);
    setTimeout(() => 
    {
      if (this.is_final_notify_sent)
      {
        return;
      }

      this.terminated_reason = 'timeout';
      this.is_final_notify_sent = true;
      this.sendNotify();
      this._dialogTerminated(C.SUBSCRIPTION_EXPIRED);
    }, this.expires * 1000);
  }
};