# error-alerts
Error alerts is a Node module dedicated to tracking messages and alerting concerned parties of thresholds reach. error-alerts makes statements like "send an email if 10 MongoDB errors have occurred in the last hour" a possiblity.

# API
```javascript
// error-alerts exports a singleton
const Alerter = require("error-alerts");

// these calls can be chained or
Alerter.root("/path/to/persistent/root").from("machine@domain.com").contact("webmaster@example.com");

// all() counts every time you tell() Alerter something
Alerter.all();

// persist metrics past program restarts 
Alerter.all().log("/leave/blank/for/default/path");

// one() counts particular messages you tell() Alerter
// one() sets default, one(value) sets for particular error/message
// control alerts by the minute(), hour() or day().
/* */
/* if you get two "i_care" message within a minute of each other,
   send me an alert. Wait 60 minutes until sending a new alert. */
Alerter.one("i_care").minute().on().threshold(2).cooldown(60);

/* don't track i_do_not_care messages at all (default behavior) */
Alerter.one("i_do_not_care").ignore();


// tell() Alerter something
Alerter.tell(new RangeError());
Alerter.tell("MongoError");

// start() reads in saved state
Alerter.start();

// get informed when your process dies
process.on("unhandledRejection", function dying_rejection(reason, promise) {
  Alerter.dead(reason, () => console.log("Done!"));
});
process.on("uncaughtException", function dying_exception(err) {
  Alerter.dead(err, () => console.log("Done!"))
});
```
