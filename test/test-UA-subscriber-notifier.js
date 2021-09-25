/* eslint no-console: 0*/

require('./include/common');
const JsSIP = require('../');
const LoopSocket = require('./include/LoopSocket');

module.exports = {
  'subscriber/notifier communication' : function(test)
  {
    test.expect(17);
	
    let notifyCounter = 0;
    const notifyMaxCounter = 1;
    const weatherRequest = 'Please report the weather condition';
    const weatherReport = '+20..+24°C, no precipitation, light wind';
    const contentType = 'text/plain'; 
    
    function createNotifier(ua, subscribe) 
    {
  
      const notifier = ua.notify(subscribe, contentType, { pending: false });

      // Receive subscribe (includes initial)
      notifier.on('subscribe', (isUnsubscribe, subs, body, contType) => 
      {
        test.strictEqual(body, weatherRequest, 'received subscribe body');
        test.strictEqual(contType, contentType, 'received subscribe content-type');
 
        if (isUnsubscribe)
        {
          notifier.terminate(weatherReport);
        }
        else 
        {
          notifier.notify(weatherReport);
        }
      });

      notifier.on('terminated', (terminationCode, sendFinalNotify) => 
      {
        if (sendFinalNotify) 
        {
          notifier.terminate(weatherReport);
        }
      });

      notifier.start();
    }

    function createSubscriber(ua)
    {
      const target = 'ikq';
      const eventName = 'weather';
      const accept = 'application/text, text/plain';
      const options = {
        expires     : 3600,
        contentType : 'text/plain',
        params      : null
      };

      const subscriber = ua.subscribe(target, eventName, accept, options);

      subscriber.on('active', () => 
      {
        test.ok(true, 'receive NOTIFY with Subscription-state: active');
      });

      subscriber.on('notify', (isFinal, notify, body, contType) => 
      {
        test.strictEqual(body, weatherReport, 'received notify body');
        test.strictEqual(contType, contentType, 'received notify content-type');
		
        if (++notifyCounter === notifyMaxCounter)
        { 
          test.ok(true, 'send unsubscrige');
          subscriber.terminate(weatherRequest);
        }
      });

      subscriber.on('terminated', (terminationCode, reason, retryAfter) => 
      {
        test.ok(terminationCode === subscriber.C.RECEIVE_FINAL_NOTIFY);   
        test.ok(reason === undefined);
        test.ok(retryAfter === undefined);		
		
        ua.stop();
        test.done();    
      });

      subscriber.on('dialogCreated', () => 
      {
        test.ok(true, 'subscribe dialog created');
      });

      subscriber.subscribe(weatherRequest);
    }

    const config = 
    {
      sockets     : new LoopSocket(), // message sending itself, with modified Call-ID
      uri         : 'sip:ikq@example.com',
      contact_uri : 'sip:ikq@abcdefabcdef.invalid;transport=ws',
      register    : false
    };

    const ua = new JsSIP.UA(config);
	
    // Uncomment to see SIP communication
    // JsSIP.debug.enable('JsSIP:*');
    
    ua.on('newSubscribe', (e) => 
    {
      test.ok(true, 'receive SUBSCRIBE');

      const subs = e.request;
      const ev = subs.parseHeader('event');
      
      test.strictEqual(ev.event, 'weather');
      if (ev.event !== 'weather')
      {
        subs.reply(489); // "Bad Event"
        
        return;
      }
      
      const accepts = subs.getHeaders('accept');
      const isAcceptOK = accepts && accepts.some((v) => v.includes('text/plain'));
      
      test.ok(isAcceptOK, 'notifier understand subscribe accept header');
      if (!isAcceptOK)
      {
        subs.reply(406); // "Not Acceptable"
        
        return;
      }
      
      createNotifier(ua, subs);   
    });
        
    ua.on('connected', () => 
    {
      createSubscriber(ua);
    });
        
    ua.start();
  }
};