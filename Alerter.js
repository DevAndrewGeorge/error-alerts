/* ==============================================
EXTERNAL MODULES
============================================== */
const fs = require("fs");
const moment = require("moment");
const sendmail = require("sendmail")();


/* ==============================================
DEFINING CUSTOM ERROR
============================================== */
class AlerterError extends Error {
  constructor(text) {
    super(text);
    this.name = "AlerterError";
  }
}


/* ==============================================
CLASS DECLARATION
============================================== */
// TODO: what if we run indefinitely?
class Alerter {
  constructor() {
    // repetitive constants / literals
    this.ALL = "_all";
    this.DEFAULT = "_default";

    // the directory where status and default log files will be placed
    this._root = undefined;

    // a variable that represents if Alerter has finished reading in its previous state
    // and is ready to start processing new errors
    this._started = false;
    this._ready = false;
    

    /* An object that keeps lists of timestamps of when errors occured.
    [_all] is for all errors. Each individual error type will also have its own key. */
    this._timestamps = {
      [this.ALL]: []
    };

    // represents timestamps that have not attempted to be written to streams yet
    // no new writes will occur if draining is true
    this._queued = {
      [this.ALL]: []
    }

    /* The three timeframes of alerts. They all have the following settings:
    ignore - disregard errors all together.
    log - a filepath. Allows you to keep track of errors through restarts.
    threshold - how many erros in the named timespan before sending an alert.
    cooldown - how long to wait before sending another alert. */
    this._settings = {
      [this.ALL]: this._blank_settings(),
      [this.DEFAULT]: this._blank_settings()
    };

    // an email or list of emails to send alerts to
    this._from = undefined;
    this._contacts = [];
  }

  all() {
    return this._one(this.ALL)
  }

  contact(contacts) {
    // TODO: smart contacts for each type of error
    if (typeof contacts === "string") {
      this._contacts = [ contacts ];
    } else if (contacts instanceof Array) {
      this._contacts = contacts;
    }
    return this;
  }

  dead(err, callback) {
    this._save();
    sendmail({
        from: this._from,
        to: this._contacts.join(","),
        subject: `ALERT: your application has crashed.`,
        text: `The uncaught error causing the crash is below:\n\n${err.toString()}\n\n${err.stack}`
      },
      function(err, reply) { callback(); }
    );
  }

  one(error) {
    return this._one(error);
  }

  from(email) {
    this._from = email;
    return this;
  }

  root(path) {
    // TODO: confirm I can write to the path
    this._root = path;
    return this;
  }

  /**
   * Can be called exactly once. Loads in previous state and opens log files.
   * Throws an error if called twice.
   * @param {function} callback (err)
   */
  start(callback) {
    // the laziest code this side of the Mississippi
    if (!callback) {
      callback = function() {};
    }

    // throw error if run more than once
    if (this._started) {
      callback(new AlerterErrror("start: starting has already been initiated"));
      return;
    }
    this._started = true;

    // creating a list of error types and their log files
    const targets = [];
    for (let error_type in this._settings) {
      const settings = this._settings[error_type];

      // nothing to do if not watching a the error type
      // or if no previous state has been enabled
      if (!settings.watch || !settings.log) {
        continue;
      }

      targets.push({
        error_type: error_type,
        log: settings.log
      });
    }

    //
    const one_day_ago = moment().subtract( moment.duration(1, 'days') ).valueOf();
    const alerter = this;
    (function() {
      // TODO: read state file
      // the remaining number of saved states to read
      let reads_left = targets.length;
      let read_error = false;

      // the remaining number of write streams left to open
      let opens_left = targets.length;
      let open_error = false;

      // tracks if the _state file has been read in yet
      let state_loaded = false;
      let state_error = false;

      function generate_readFile_callback(key) {
        function readFile_callback(err, data) {
          // if an concurrent error has already occurred, do nothing
          if (read_error || open_error || state_error) {
            return;
          }

          // report an error if first read/open to do so
          /* the only error that will not trigger a callback
            is if the file simple does not exist */
          if (err && err.code !== "ENOENT") {
            read_error = true;
            callback(err);
            return;
          } else if (err) {
            data = "";
          }

          // parsing and loading the state
          // TODO: since the data is already sorted, this could be optimized
          const timestamps = data.split(
            "\n"
          ).map(
            timestamp => parseInt(timestamp)
          ).filter(
            timestamp => timestamp >= one_day_ago
          );
          reads_left--;

          // now configuring up a write stream
          alerter._settings[key].stream = fs.createWriteStream(
            alerter._settings[key].log
          ).on(
            "drain",
            function _set_draining() { alerter._settings[key].draining = false; }
          );

          // preparing to rewrite file to remove stale data
          alerter._queued[key] = timestamps.concat(alerter._queued[key] || []);

          // updating counts, and starting
          opens_left--;
          if (!reads_left && !opens_left && state_loaded) {
            alerter._ready = true;
            alerter._flush_queued();
            callback();
          }
        }

        return readFile_callback;
      }

      function read_state_callback(err, data) {
        // if an concurrent error has already occurred, do nothing
        if (read_error || open_error || state_error) {
          return;
        }

        // report an error if first to do so
        /* the only error that will not trigger a callback
        is if the file simple does not exist */
        if (err && err.code !== "ENOENT") {
          state_error = true;
          callback(err);
          return;
        } else if (err) {
          data = "{}";
        }

        // import saved settings
        const json = JSON.parse(data);
        for (let error_type in json) {
          const error_settings = alerter._settings[error_type];

          // do nothing if the error_type has not be configured for this Alerter
          if (!alerter._settings[error_type]) {
            continue;
          }

          error_settings.minute.last_alert = json[error_type].minute;
          error_settings.hour.last_alert = json[error_type].hour;
          error_settings.day.last_alert = json[error_type].day;
        }

        // all done
        state_loaded = true;

        if (!reads_left && !opens_left && state_loaded) {
          alerter._ready = true;
          alerter._flush_queued();
          callback();
        }
      }

      targets.forEach(target => {
        fs.readFile(
          target.log,
          { encoding: "utf8" },
          generate_readFile_callback(target.error_type)
        );
      });

      // import saved state settings
      fs.readFile(
        `${alerter._root}/_state`,
        { encoding: "utf8" },
        read_state_callback
      );
    })();
  }

  /**
   * Updates lists and logs of errors. Sounds the alarm if thresholds reached.
   * @param {Error} error 
   */
  tell(error) {
    // checking if there an actual error to log
    if (!error || !(error instanceof Error)) {
      return;
    }

    // timestamp to be used both globally and specifically
    // work is done here to have a single timestamp across _all and specific case
    const current_time = Date.now();

    // globally logging erorr
    if (this._settings[this.ALL].watch) {
      this._tell(this.ALL, current_time);
    }

    // logging specific error
    const key = this._key(error);
    if (this._settings[key].watch) {
      this._tell(key, current_time);
    }
  }

  _alert(error_type, trigger_name) {
    sendmail({
      from: this._from,
      to: this._contacts.join(", "),
      subject: `ALERT: ${error_type} has reached its ${trigger_name} threshold.`
    });
    this._save();
  }

  _blank_settings() {
    return {
      watch: true,
      log: false,
      stream: undefined,
      draining: false,
      act: function () {},
      minute: {
        enabled: false,
        threshold: undefined,
        cooldown: undefined,
        last_alert: undefined
      },
      hour: {
        enabled: false,
        threshold: undefined,
        cooldown: undefined,
        last_alert: undefined
      },
      day: {
        enabled: false,
        threshold: undefined,
        cooldown: undefined,
        last_alert: undefined
      }
    };
  }

  _check(error_type, current_time) {
    const checks = {
      minute: this._settings[error_type]["minute"],
      hour: this._settings[error_type]["hour"],
      day: this._settings[error_type]["day"]
    };

    // how many milliseconds a threshold must be reached in
    const window = {
      minute: 60000,
      hour: 3600000,
      day: 86400000
    };

    for (let check_key in checks) {
      const check = checks[check_key];

      // do no work if no work desired
      if (!check.enabled) {
        continue;
      }

      // do not work if contacts have already been alerted recently
      if (check.last_alert && check.cooldown !== undefined) {
        // last_alert >= (current_time - cooldown)
        const cooldown_timestamp = moment(current_time).subtract(moment.duration(check.cooldown, 'minutes'));
        if (check.last_alert >= cooldown_timestamp) {
          continue;
        }
      }

      // determine if an contacts need to be alerted
      const range = this._find_range(
        error_type, 
        { from: current_time - window[check_key] }
      );

      const error_count = range.to - range.from + 1;
      if (error_count >= check.threshold) {
        check.last_alert = current_time;
        this._alert(error_type, check_key);
        this._settings[error_type].act(error_type, check_key);
      }
    }
  }

  _draft_alert(error_type) {

  }

  _draft_dead() {

  }

  _edit_timespan(settings, timespan_key) {
    const timespan = settings[timespan_key];
    const funcs = {};

    funcs["on"] = function _set_on() {
      timespan.enabled = true;
      return funcs;
    }

    funcs["off"] = function _set_off() {
      timespan.enabled = false;
      return funcs;
    }

    funcs["threshold"] = function _set_threshold(threshold) {
      timespan.threshold = threshold;
      return funcs;
    }

    funcs["cooldown"] = function _set_cooldown(cooldown) {
      timespan.cooldown = cooldown;
      return funcs;
    }

    return function _return_timespan() {
      return funcs;
    }
  }

  /**
   * Overglorified binary search. Returns the first index that is greater than or equal to [target].
   * @param {*} target 
   * @param {*} timestamps 
   * @param {*} from 
   * @param {*} to 
   */
  _find_bound(target, timestamps, left, right) {
    // default bounds
    if (left === undefined) {
      left = 0;
    }

    if (right === undefined) {
      right = timestamps.length - 1;
    }

    // fun cases
    if (target <= timestamps[0]) {
      return 0;
    } else if (target > timestamps[timestamps.length - 1]) {
      return timestamps.length;
    } else if (left === right) {
      return left;
    }

    // 
    let middle = Math.floor((right - left) / 2) + left;

    // CASE: we hit it
    // we must now check to see if it's not the first is a series of duplicates
    if (timestamps[middle] === target) {
      while(timestamps[middle - 1] === target) {
        middle--;
      }
      return middle;
    }

    if (target > timestamps[middle]) {
      left = middle + 1;
      return this._find_bound(target, timestamps, left, right);
    }

    if (target < timestamps[middle]) {
      right = middle;
      return this._find_bound(target, timestamps, left, right);
    }
  }

  /**
   * Returns an object with (from, to).
   * From respresents the zero-based index of the first timestamp greater than or equal [range.from].
   * To represents the zer-based index of the first timestamp less than or equal [range.to].
   * @param {String} error_type 
   * @param {Object} range Contains from, to.
   * @returns {Object} 
   */
  _find_range(error_type, range) {
    const saved = this._timestamps[error_type] || [], queued = this._queued[error_type] || [];
    const timestamps = saved.concat(queued);

    /* it is assumed if no from/to is provided,
       the user does not care about the bound and thefore wants the entire history. */
    const results = { from: 0, to: timestamps.length - 1 };

    if (range.from) {
      results.from = this._find_bound(range.from, timestamps);
    }

    if (range.to) {
      results.to = this._find_bound(range.from, timestamps);
      if (results.to === timestamps.length) {
        results.to--;
      }
    }

    return results;
  }

  /**
   * Attempts to write queued timestamps to their appropriate stream.
   */
  _flush_queued() {
    for (let error_type in this._queued) {
      const timestamps = this._queued[error_type] || [];
      // if write is successful, transfer queued over
      if (this._write(error_type, timestamps)) {
        this._timestamps[error_type] = (this._timestamps[error_type] || []).concat(this._queued[error_type] || []);
        delete this._queued[error_type];
      }
    }
  }

  _key(error) {
    let key = this.DEFAULT;
    if (typeof error === "string") {
      key = error;
    } else if (error instanceof Error) {
      key = error.constructor.name;
    }

    return key;
  }

  _one(error) {
    // key whose settings we will be editing
    let key = this._key(error);
    

    // getting the settings object for the particular error
    // if it does not already exist, create it
    if (!(key in this._settings)) {
      this._settings[key] = this._blank_settings();
    }
    const error_settings = this._settings[key];
    const alerter = this;

    //
    const obj = {
      minute: this._edit_timespan(error_settings, "minute"),
      hour: this._edit_timespan(error_settings, "hour"),
      day: this._edit_timespan(error_settings, "day")
    };

    obj["watch"] = function _set_unwatch() {
      error_settings.watch = true;
      return obj;
    }

    obj["ignore"] = function _set_watch() {
      error_settings.watch = false;
      return obj;
    }

    obj["log"] = function _set_log(path) {
      error_settings.log = path === true ? `${alerter._root}/${key}.log` : path;
      return obj;
    }

    obj["act"] = function _set_act(func) {
      error_settings.act = func;
      return obj;
    }

    return obj;
  }

  _save() {
    const state = {};

    for (let error_type in this._settings) {
      state[error_type] = {
        "minute": this._settings[error_type].minute.last_alert,
        "hour": this._settings[error_type].hour.last_alert,
        "day":this._settings[error_type].day.last_alert
      };
    }

    fs.writeFileSync(`${this._root}/_state`, JSON.stringify(state));
  }

  _tell(key, current_time) {
    // queueing the erro to be saved to a long
    if (this._queued[key]) {
      this._queued[key].push(current_time);
    } else {
      this._queued[key] = [ current_time ];
    }

    // begin writing to a file
    this._flush_queued();

    // checking to see if anything has been triggered for _all
    this._check(key, current_time);
  }

  /**
   * Attempts to write data to a stream.
   * @param {String} error_type 
   * @param {Array|String|Integer} data UNIX timestamp(s) in milliseconds.
   * @returns True if write was successful or is not necessary. False if data could not be written.
   */
  _write(error_type, data) {
    const error_settings = this._settings[error_type];
    const stream = error_settings.stream;

    // nothing to do if logging has not been configured
    if (!error_settings.log) {
      return true;
    }

    // do nothing if we're currently draining
    // or if the stream is not setup/open
    if (error_settings.draining || !stream) {
      return false;
    }

    // transforming data if need be
    if (data instanceof Array) {
      data = data.join("\n") + "\n";
    }

    /* draining indicates the buffer is now filled
       and we need to wait before writing anymore */
    const draining = !stream.write(data);
    if (draining) {
      error_settings.draining = true;
    }

    return true;
  }
}


/* ==============================================
EXPORTS
============================================== */
module.exports = new Alerter();
