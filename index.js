"use strict";

let Service, Characteristic, api;

const _http_base = require("homebridge-http-base");
const PullTimer = _http_base.PullTimer;
const notifications = _http_base.notifications;
const Cache = _http_base.Cache;
const utils = _http_base.utils;
const https = require('https');
const packageJSON = require("./package.json");

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    api = homebridge;

    homebridge.registerAccessory(
        "homebridge-weather-cloud-inside-temperature-sensor",
        "WeatherCloudInsideTemperature",
        WeatherCloudInsideTemperature
    );
};

const TemperatureUnit = Object.freeze({
    Celsius: "celsius",
    Fahrenheit: "fahrenheit"
});

function WeatherCloudInsideTemperature(log, config) {
    this.log = log;
    this.name = config.name;
    this.debug = config.debug || false;

    if (config.login) {
        this.login = config.login;
    } else {
        this.log.warn("Property 'login' is required!");
        this.log.warn("Aborting...");
        return;
    }

    if (config.password) {
        this.password = config.password;
    } else {
        this.log.warn("Property 'password' is required!");
        this.log.warn("Aborting...");
        return;
    }

    if (config.deviceCode) {
        this.deviceCode = config.deviceCode;
    } else {
        this.log.warn("Property 'deviceCode' is required!");
        this.log.warn("Aborting...");
        return;
    }

    this.unit = utils.enumValueOf(TemperatureUnit, config.unit, TemperatureUnit.Celsius);
    if (!this.unit) {
        this.unit = TemperatureUnit.Celsius;
        this.log.warn(`${config.unit} is an unsupported temperature unit! Using default!`);
    }

    this.statusCache = new Cache(config.statusCache, 60000);

    this.homebridgeService = new Service.TemperatureSensor(this.name);

    this.homebridgeService.getCharacteristic(Characteristic.CurrentTemperature)
        .setProps({
            minValue: -100,
            maxValue: 100
        })
        .on("get", this.getTemperature.bind(this));

    /** @namespace config.pullInterval */
    if (config.pullInterval) {
        this.pullTimer = new PullTimer(log, config.pullInterval, this.getTemperature.bind(this), value => {
            this.homebridgeService.setCharacteristic(Characteristic.CurrentTemperature, value);
        });
        this.pullTimer.start();
    }

    /** @namespace config.notificationPassword */
    /** @namespace config.notificationID */
    notifications.enqueueNotificationRegistrationIfDefined(
        api,
        log,
        config.notificationID,
        config.notificationPassword,
        this.handleNotification.bind(this)
    );

}

WeatherCloudInsideTemperature.prototype = {

    identify: function (callback) {
        this.log("Identify requested!");
        callback();
    },

    getServices: function () {
        if (!this.homebridgeService) {
            return [];
        }

        this.informationService = new Service.AccessoryInformation();

        this.informationService
            .setCharacteristic(Characteristic.Manufacturer, "Martin Hampl")
            .setCharacteristic(Characteristic.Model, "Weather Cloud Inside Temperature Sensor")
            .setCharacteristic(Characteristic.SerialNumber, "MH01")
            .setCharacteristic(Characteristic.FirmwareRevision, packageJSON.version);

        return [this.informationService, this.homebridgeService];
    },

    handleNotification: function (body) {
        const characteristic = utils.getCharacteristic(this.homebridgeService, body.characteristic);
        if (!characteristic) {
            this.log("Encountered unknown characteristic when handling notification " +
                "(or characteristic which wasn't added to the service): " + body.characteristic);
            return;
        }

        let value = body.value;
        if (body.characteristic === "CurrentTemperature" && this.unit === TemperatureUnit.Fahrenheit)
            value = (value - 32) / 1.8;

        if (this.debug) {
            this.log("Updating '" + body.characteristic + "' to new value: " + body.value);
        }
        characteristic.updateValue(value);
    },

    getTemperature: function (callback) {
        const latestValue = this.homebridgeService.getCharacteristic(Characteristic.CurrentTemperature).value;
        if (!this.statusCache.shouldQuery()) {
            if (this.debug) {
                this.log(`getTemperature() returning cached value ${value}${this.statusCache.isInfinite() ? " (infinite cache)" : ""}`);
            }
            callback(null, latestValue);
            return;
        }

        callback(null, latestValue);

        if (this.pullTimer) {
            this.pullTimer.resetTimer();
        }

        if (!this.latestCookies) {
            const promise = new Promise((resolve, reject) => this.initGet(resolve, reject));
            this.processPromise(promise, callback);
            return;
        }

        try {
            const promise = new Promise((resolve, reject) => this.fetchData(resolve, reject));
            this.processPromise(promise, callback);
        } catch (e) {
            this.log.warn(`Unable get data from weather cloud!`, e);
            try {
                const promise = new Promise((resolve, reject) => this.initGet(resolve, reject));
                this.processPromise(promise, callback);
            } catch (e) {
                this.log.error(`Unable login into weather cloud!`, e);
                callback(new Error("Promise Error:" + e));
            }
        }
    },

    processPromise(promise, callback) {
        promise.then(response => {
            let temperature = response.tempin;
            this.log.debug(`Temperature ${temperature}°C successfully fetched from Weather Cloud for device ${this.deviceCode}`);
            if (this.unit === TemperatureUnit.Fahrenheit) {
                temperature = (temperature - 32) / 1.8;
            }
            this.statusCache.queried();
            this.homebridgeService.getCharacteristic(Characteristic.CurrentTemperature).updateValue(temperature);
        }, error => {
            callback(new Error("Promise Error:" + error));
        });
    },


    initGet(resolve, reject) {
        this.log.info(`Loading CSRF token Weather Cloud home page`);
        https.get('https://app.weathercloud.net', (res) => {
            res.resume();
            const cookies = this.buildCookiesMap(res.headers['set-cookie']);
            this.loginIntoWeatherCloud(resolve, reject, cookies);
        });
    },

    loginIntoWeatherCloud(resolve, reject, cookies) {
        this.log.info(`Sign in into Weather Cloud using login ${this.login}`);
        const body = `LoginForm%5Bentity%5D=${this.login}&LoginForm%5Bpassword%5D=${this.password}`;
        const options = {
            host: 'app.weathercloud.net',
            path: '/signin',
            method: 'POST',
            headers: {
                'Cookie': this.stringifyCookies(cookies),
                'Content-Type': "application/x-www-form-urlencoded",
                'Content-Length': body.length,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9'
            }
        };
        const post_req = https.request(options, (res) => {
            if (res.statusCode !== 302) {
                this.log.warn(`Redirect expected but get Code: ${res.statusCode}`, res);
                res.resume();
                reject('Login failed!');
                return;
            }
            this.latestCookies = {...cookies, ...this.buildCookiesMap(res.headers['set-cookie'])};
            res.resume();
            this.fetchData(resolve, reject)
        });
        post_req.write(body);
        post_req.end();

    },

    fetchData(resolve, reject) {
        this.log.debug(`Loading temperature from app.weathercloud.net/device/values?code=${this.deviceCode}`);
        const options = {
            host: 'app.weathercloud.net',
            path: '/device/values?code=3671694794',
            method: 'GET',
            headers: {
                'Cookie': this.stringifyCookies(this.latestCookies),
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'X-Requested-With': 'XMLHttpRequest'
            }
        };
        const request = https.request(options, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(`Error code returned Code: ${res.statusCode}`)
                return;
            }
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('close', () => {
                resolve(JSON.parse(data));
            });
        });
        request.end();
        request.on('error', (err) => reject(`Encountered an error trying to make a request: ${err.message}`))
    },


    stringifyCookies(cookies) {
        let cookieString = '';
        Object.keys(cookies).forEach(k => {
            if (cookieString.endsWith(';')) {
                cookieString += ' ';
            }
            cookieString += `${k}=${cookies[k]};`;
        });
        return cookieString;
    },

    buildCookiesMap(setCookies) {
        const cookies = {};
        setCookies.forEach(setCookie => {
            const c1 = setCookie.split(';')[0];
            cookies[c1.split('=')[0]] = c1.split('=')[1];
        });
        return cookies;
    }

};
