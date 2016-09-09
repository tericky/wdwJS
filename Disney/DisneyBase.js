// get the base Park class
var Park = require("../parkBase");
// moment library for time formatting
var moment = require("moment-timezone");

// cache resort schedules
var scheduleCache = {};

// export the Disney base park object
module.exports = DisneyBase;

function DisneyBase(config) {
  // keep hold of 'this'
  var self = this;

  self.name = self.name || "Generic Disney Park";

  // Disney parks support returning schedules for rides
  self.supports_ride_schedules = true;

  // base API URL to use for requests
  self.APIBase = self.APIBase || "https://api.wdpro.disney.go.com/facility-service/";

  // set resort ID
  self.resort_id = self.resort_id;
  if (config && !self.resort_id) self.resort_id = config.resort_id;
  // default resort ID is "dlp" (Disneyland Paris)
  if (!self.resort_id) self.resort_id = "dlp";

  // Call to parent class "Park" to inherit
  Park.call(self, config);

  // generate a random Android useragent
  self.RandomiseUseragent(function(ua) {
    return (ua.osName == "Android");
  });

  // store/cache access token
  //  will be an object with string 'token' and unix timestamp 'expires'
  self._accessToken = null;
  // access token URL requester
  self._accessTokenURL = self._accessTokenURL || "https://authorization.go.com/token";
  self._accessTokenURLBody = self._accessTokenURLBody || "grant_type=assertion&assertion_type=public&client_id=WDPRO-MOBILE.MDX.WDW.ANDROID-PROD";
  self._accessTokenURLMethod = self._accessTokenURLMethod || "POST";

  self._appID = self._appID || "WDW-MDX-ANDROID-3.4.1";

  // possible strings we expect from Disney API.
  //  For anything other than these we will return "Closed"
  self._expectedRideStatusStrings = ["Operating", "Closed", "Down"];

  // Generic implementation of GetWaitTimes
  //  can be overriden if needed
  this.GetWaitTimes = function(callback) {
    // check the park ID is set
    if (!self.park_id) return self.Error("Park not configured correctly", "Park ID not configured", callback);
    if (!self.park_region) return self.Error("Park not configured correctly", "Park region not configured", callback);

    // make sure we have schedule data cached (for ride opening and closing times)
    self.CacheScheduleData(function(error) {
      if (error) return self.Error("Error getting schedule data cache", error, callback);

      // fetch wait times from API
      self.FetchURL(self.ContructWaitTimesURL(), {
          data: {
            region: self.park_region,
          },
        },
        function(err, data) {
          if (err) return self.Error("Error fetching wait times", err, callback);
          if (!data) return self.Error("No data returned for wait times", "data is null", callback);
          if (!data.entries) return self.Error("Invalid data returned from API (no entries)", data, callback);

          // work out current time for use with schedule sorting in the for-loop
          var timeNow = moment();
          // get today's date
          var dateToday = moment().tz(self.park_timezone).format("YYYY-MM-DD");

          // build ride array
          var rides = [];
          for (var i = 0; i < data.entries.length; i++) {
            var ride = data.entries[i];

            if (ride.id && ride.name && ride.type && ride.type == "Attraction") {

              var obj = {
                id: self.CleanRideID(ride.id),
                name: ride.name
              };

              // try to find wait time value
              if (ride.waitTime && ride.waitTime && ride.waitTime.postedWaitMinutes) {
                // report the posted wait time if present
                obj.waitTime = ride.waitTime.postedWaitMinutes;
              } else {
                // zero if we cannot find a wait time
                obj.waitTime = 0;
              }

              // work out if the ride is active
              obj.active = (ride.waitTime && ride.waitTime.status == "Operating") ? true : false;

              // return a status string, forcing to "CLosed" if we get anything unexpected
              obj.status = (ride.waitTime && self._expectedRideStatusStrings.indexOf(ride.waitTime.status) >= 0 ? ride.waitTime.status : "Closed");

              // work out if we have fastpass
              obj.fastPass = (ride.waitTime.fastPass && ride.waitTime.fastPass.available);

              // check schedule cache for opening and closing time data
              obj.schedule = {};
              if (scheduleCache[self.resort_id] && scheduleCache[self.resort_id].data[obj.id]) {
                // sort through data to find the current or next opening times
                //  if we find times we're in right now, use those
                //  otherwise... use the current day's (in park's timezone) schedule
                // why?? because when parks open past midnight, we don't want to
                //  return tomorrow's data if the ride is still running
                var todaysSchedule = null;

                for (var j = 0, time; time = scheduleCache[self.resort_id].data[obj.id][j++];) {
                  // if we find today's schedule, store it for later in case we aren't inside an existing schedule
                  if (time.date == dateToday) todaysSchedule = time;

                  // check if this schedule is currently active
                  if (timeNow.isBetween(time.openingTime, time.closingTime)) {
                    obj.schedule = time;
                  }
                }

                // if we aren't already in an active schedule, see if we found
                //  today's schedule and use that instead
                if (!obj.schedule.openingTime || !obj.schedule.closingTime) {
                  if (todaysSchedule) {
                    // if we found today's schedule...
                    obj.schedule = todaysSchedule;
                  } else if (scheduleCache[self.resort_id].data[obj.id].length) {
                    // ... otherwise, just use the first one available
                    obj.schedule = scheduleCache[self.resort_id].data[obj.id][0];
                  } else {
                    // failed to find any schedule data? return null object
                    obj.schedule = null;
                  }
                }

                // for live ride data, doesn't make sense to have today's date
                if (obj.schedule && obj.schedule.date) delete obj.schedule.date;
              } else {
                // if we got no schedule data from API, this attraction is open "all day"
                obj.schedule = {
                  openingTime: moment().tz(self.park_timezone).startOf("day").format(self.timeFormat),
                  closingTime: moment().tz(self.park_timezone).endOf("day").format(self.timeFormat),
                  type: obj.active ? "Operating" : "Closed",
                };
              }

              // add to our return rides array
              rides.push(obj);
            }
          }

          return callback(null, rides);
        });
    });
  };

  // Create the URL for requesting wait times
  this.ContructWaitTimesURL = function() {
    return self.APIBase + "theme-parks/" + self.park_id + ";destination\u003d" + self.resort_id + "/wait-times";
  };

  // get park opening times (also fetches ride times, which we'll cache)
  this.GetOpeningTimes = function(callback) {
    // make sure we have some cached schedule data
    self.CacheScheduleData(function(error) {
      if (error) return self.Error("Error caching schedule data", error, callback);

      // grab park schedule data from cache
      if (scheduleCache[self.resort_id]) {
        if (scheduleCache[self.resort_id].expires >= Date.now()) {
          // return cached data!
          if (scheduleCache[self.resort_id].data[self.park_id] && scheduleCache[self.resort_id].data[self.park_id].length) {
            return callback(null, scheduleCache[self.resort_id].data[self.park_id]);
          }
        }
      }

      self.Dbg("Found no schedule data for this park! Assuming park not open yet.");

      // make forever closed schedule
      var startDate = moment().tz(self.park_timezone).startOf('day');
      var endDate = moment().add(self.scheduleMaxDates, "days").tz(self.park_timezone).endOf('day');

      var schedule = [];
      for (var day = startDate; day.isSameOrBefore(endDate); day.add(1, "day")) {
        schedule.push({
          "date": day.format(self.dateFormat),
          "type": "Closed",
        });
      }

      return callback(null, schedule);
    });
  };

  // Call this to ensure we have some cached schedule data for this park
  this.CacheScheduleData = function(callback) {
    if (scheduleCache[self.resort_id]) {
      if (scheduleCache[self.resort_id].expires >= Date.now()) {
        // return no error message to confirm cache successful
        return callback(null, scheduleCache);
      }
    }

    // get start and end date in park's timezone
    var startDate = moment().tz(self.park_timezone).startOf('day');
    var endDate = moment().add(self.scheduleMaxDates, "days").tz(self.park_timezone).endOf('day');

    self.FetchURL(self.ConstructScheduleURL(startDate, endDate), {
      data: self.ConstructScheduleData(startDate, endDate)
    }, function(err, data) {
      if (err) return self.Error("Error fetching park schedule", err, callback);
      if (!data) return self.Error("No schedule data returned", null, callback);

      // parse/extract schedule data
      self.ParseScheduleData(data, startDate, endDate, function(err, times) {
        if (err) return callback(err);

        // just return no error message, as we have now cached the data
        return callback(null, scheduleCache);
      });
    });
  };

  this.ConstructScheduleURL = function(startDate, endDate) { // get schedules for theme parks and attractions
    return "https://api.wdpro.disney.go.com/mobile-service/public/ancestor-activities-schedules/" + self.resort_id + ";entityType=destination";
  };

  this.ConstructScheduleData = function(startDate, endDate) {
    return {
      "filters": "theme-park,Attraction",
      // start and end date to fetch between
      "startDate": startDate.format("YYYY-MM-DD"),
      "endDate": endDate.format("YYYY-MM-DD"),
      // must supply a region for DLP
      "region": self.park_region
    };
  };

  // default schedule data parser
  //  override for any special park implementations
  this.ParseScheduleData = function(data, startDate, endDate, callback) {
    if (!data.activities) return self.Error("No schedule data returned", JSON.stringify(data, null, 2), callback);

    var schedule = {};

    // these are the non-special operating types
    //  anything not in this array will appear under "special"
    var openingTypes = ["Operating", "Closed", "Refurbishment"];

    for (var i = 0, sched; sched = data.activities[i++];) {
      // if object has no schedule data, ignore
      if (!sched.schedule || !sched.schedule.schedules) continue;

      var times = {};

      // first add all the "normal" operating hours
      for (var j = 0, time; time = sched.schedule.schedules[j++];) {
        // if we treat this type as a standard operating type
        if (openingTypes.indexOf(time.type) >= 0) {
          var day = moment.tz(time.date, self.park_timezone);
          // skip this entry if it's after the last date we are interested in
          if (day.isAfter(endDate)) continue;
          if (day.isBefore(startDate)) continue;

          // add standard opening times to object
          var dayObj = self.ParseScheduleEntry(time);
          dayObj.special = [];
          dayObj.date = day.format(self.dateFormat);
          // anything other than Operating is assumed to mean Closed (refurbs etc.)
          dayObj.type = (time.type == "Operating" ? "Operating" : "Closed");
          times[dayObj.date] = dayObj;
        }
      }

      // now back-fill all the special hours
      for (var j = 0, time; time = sched.schedule.schedules[j++];) {
        if (openingTypes.indexOf(time.type) < 0) {
          var day = moment.tz(time.date, self.park_timezone);
          // skip this entry if it's after the last date we are interested in
          if (day.isAfter(endDate)) continue;
          if (day.isBefore(startDate)) continue;

          var dayFormatted = day.format(self.dateFormat);

          // add non-standard to the standard date objects
          var dayObj = self.ParseScheduleEntry(time);

          // inject special hours type into object
          dayObj.type = time.type;

          // add onto special hours array for this day
          if (times[dayFormatted]) times[dayFormatted].special.push(dayObj);
        }
      }

      // populate any missing days with closed data
      for (var day = startDate.clone(); day.isSameOrBefore(endDate); day.add(1, "day")) {
        var dayFormatted = day.format(self.dateFormat);

        if (!times[dayFormatted] || !times[dayFormatted].date) {
          times[dayFormatted] = {
            date: day.format(self.dateFormat),
            openingTime: day.startOf().format(self.timeFormat),
            closingTime: day.endOf().format(self.timeFormat),
            type: "Closed",
          };
        }
      }

      // convert from object into array
      var timeArray = [];
      for (var day in times) {
        timeArray.push(times[day]);
      }

      // store schedule for this park/ride
      schedule[self.CleanRideID(sched.id)] = timeArray;
    }

    // store schedule data for this resort in cache
    scheduleCache[self.resort_id] = {
      // refetch every 12 hours
      expires: Date.now() + 1000 * 60 * 60 * 12,
      data: schedule,
    };

    // return schedule data for this park
    return callback(null, scheduleCache[self.resort_id].data[self.park_id]);
  };

  this.ParseScheduleEntry = function(entry) {
    // work out opening closing times based on date added to the opening/closing time strings
    var openingTime = moment.tz(entry.date + entry.startTime, "YYYY-MM-DDHH:mm", self.park_timezone);
    var closingTime = moment.tz(entry.date + entry.endTime, "YYYY-MM-DDHH:mm", self.park_timezone);

    // if closing time happens before opening time, must have overspilled into following day
    if (closingTime.isBefore(openingTime)) {
      closingTime.add("1", "day");
    }

    return {
      // format opening and closing times in 'timeFormat' format
      openingTime: openingTime.tz(self.timeFormatTimezone).format(self.timeFormat),
      closingTime: closingTime.tz(self.timeFormatTimezone).format(self.timeFormat),
    };
  };

  self.regexTidyID = /^([^;]+)/;
  // clean up ride IDs returned by API
  this.CleanRideID = function(ride_id) {
    var capture = self.regexTidyID.exec(ride_id);
    if (capture && capture.length > 1) {
      return capture[1];
    }
    return ride_id;
  };

  // Fetch cached/new access token for Disney API methods
  this.GetAccessToken = function(callback) {
    // if we already have an access token, check it is still valid
    if (self._accessToken) {
      // if token has expired...
      if (self._accessToken.expires <= new Date().getTime()) {
        // ... set to null ...
        self.Dbg("Access token has expired, fetching new one");
        self._accessToken = null;
      } else {
        // ... otherwise, return it
        return callback(null, self._accessToken.token);
      }
    }

    // no (valid) cached access token, request a new one!
    self.FetchAccessToken(function(err, token, expires) {
      if (err) return callback(err);

      // cache token for later
      self._accessToken = {
        token: token,
        expires: expires,
      };

      // return access token
      return callback(null, token);
    });
  };

  // Make the network request to create a new access token
  this.FetchAccessToken = function(callback) {
    self.MakeNetworkRequest({
      name: "Fetch Disney Access Token",
      url: self._accessTokenURL,
      method: self._accessTokenURLMethod,
      body: self._accessTokenURLBody,
    }, function(err, resp, body) {
      if (err) return self.Error("Failed to get access token", err, callback);

      if (resp.statusCode != 200) {
        return self.Error("Unexpected status code for access token response, expected 200", "Got " + resp.statusCode, callback);
      }

      // parse JSON data from response
      var data;
      try {
        data = JSON.parse(body);
      } catch (e) {
        return self.Error("Invalid JSON returned for access token", e, callback);
      }

      if (data && data.access_token && data.expires_in) {
        var expire_time = (new Date().getTime()) + (Math.max(data.expires_in - 30, 5) * 1000);

        if (data.expires_in < 5) {
          return callback("Expirey time is very low: " + data.expires_in);
        }

        self.Dbg("Fetched access token ", data.access_token, "Expires in", data.expires_in, "Expires at", expire_time);

        return callback(null, data.access_token, expire_time);
      }

      return self.Error("Invalid body response for access token", null, callback);
    });
  };

  // Fetch a WDWjs API URL
  this.FetchURL = function(url, options, callback) {
    // first, get a valid access token
    self.GetAccessToken(function(err, token) {
      if (err) return self.Error("Error getting access token for API URL", err, callback);

      // setup request headers
      var headers = {
        'Authorization': "BEARER " + self._accessToken.token,
        'Accept': 'application/json;apiversion=1',
        'X-Conversation-Id': 'WDPRO-MOBILE.MDX.CLIENT-PROD',
        'X-App-Id': self._appID,
        'X-Correlation-ID': Date.now(),
      };

      // add/override headers if passed in
      if (options.headers) {
        for (var name in options.headers) headers[name] = options.headers;
      }

      // setup options for request lib
      var requestBody = {
        url: url,
        method: options.method || "GET",
        headers: headers,
      };

      // add data to request object (if we have any)
      if (options.data) {
        if (requestBody.method == "GET") {
          requestBody.qs = options.data;
        } else {
          requestBody.data = options.data;
        }
      }

      // make the network request using our standard requster (wrapper for request())
      self.MakeNetworkRequest(requestBody, function(err, resp, body) {
        // if we get an instance ID from the load balancer, store it
        //  (even if we get an error)
        if (resp && resp.headers && resp.headers["x-correlation-id"] && self._accessToken) {
          self._accessToken.correlation = resp.headers["x-correlation-id"];
        }

        if (err) return self.Error("Error making API request", err, callback);

        // attempt to parse the body for JSON Data
        var JSONData = false;
        try {
          JSONData = JSON.parse(body);
        } catch (e) {
          return self.Error("Invalid JSON data returned by API", e, callback);
        }

        return callback(null, JSONData);
      });
    });
  };
}

// sort out prototype inheritance
DisneyBase.prototype = Object.create(Park.prototype);
DisneyBase.prototype.constructor = DisneyBase;
