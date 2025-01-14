/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function (RED) {
    "use strict";
    var bodyParser = require("body-parser");
    var multer = require("multer");
    var cookieParser = require("cookie-parser");
    var getBody = require('raw-body');
    var cors = require('cors');
    var onHeaders = require('on-headers');
    var typer = require('content-type');
    var mediaTyper = require('media-typer');
    var isUtf8 = require('is-utf8');
    var hashSum = require("hash-sum");
    var express = require("express");

    function rawBodyParser(req, res, next) {
        if (req.skipRawBodyParser) {
            next();
        } // don't parse this if told to skip
        if (req._body) {
            return next();
        }
        req.body = "";
        req._body = true;

        var isText = true;
        var checkUTF = false;

        if (req.headers['content-type']) {
            var contentType = typer.parse(req.headers['content-type'])
                if (contentType.type) {
                    var parsedType = mediaTyper.parse(contentType.type);
                    if (parsedType.type === "text") {
                        isText = true;
                    } else if (parsedType.subtype === "xml" || parsedType.suffix === "xml") {
                        isText = true;
                    } else if (parsedType.type !== "application") {
                        isText = false;
                    } else if ((parsedType.subtype !== "octet-stream")
                         && (parsedType.subtype !== "cbor")
                         && (parsedType.subtype !== "x-protobuf")) {
                        checkUTF = true;
                    } else {
                        // application/octet-stream or application/cbor
                        isText = false;
                    }

                }
        }

        getBody(req, {
            length: req.headers['content-length'],
            encoding: isText ? "utf8" : null
        }, function (err, buf) {
            if (err) {
                return next(err);
            }
            if (!isText && checkUTF && isUtf8(buf)) {
                buf = buf.toString()
            }
            req.body = buf;
            next();
        });
    }

    var corsSetup = false;

    function createRequestWrapper(node, req) {
        // This misses a bunch of properties (eg headers). Before we use this function
        // need to ensure it captures everything documented by Express and HTTP modules.
        var wrapper = {
            _req: req
        };
        var toWrap = [
            "param",
            "get",
            "is",
            "acceptsCharset",
            "acceptsLanguage",
            "app",
            "baseUrl",
            "body",
            "cookies",
            "fresh",
            "hostname",
            "ip",
            "ips",
            "originalUrl",
            "params",
            "path",
            "protocol",
            "query",
            "route",
            "secure",
            "signedCookies",
            "stale",
            "subdomains",
            "xhr",
            "socket" // TODO: tidy this up
        ];
        toWrap.forEach(function (f) {
            if (typeof req[f] === "function") {
                wrapper[f] = function () {
                    node.warn(RED._("httpin.errors.deprecated-call", {
                            method: "msg.req." + f
                        }));
                    var result = req[f].apply(req, arguments);
                    if (result === req) {
                        return wrapper;
                    } else {
                        return result;
                    }
                }
            } else {
                wrapper[f] = req[f];
            }
        });

        return wrapper;
    }
    function createResponseWrapper(node, res) {
        var wrapper = {
            _res: res
        };
        var toWrap = [
            "append",
            "attachment",
            "cookie",
            "clearCookie",
            "download",
            "end",
            "format",
            "get",
            "json",
            "jsonp",
            "links",
            "location",
            "redirect",
            "render",
            "send",
            "sendfile",
            "sendFile",
            "sendStatus",
            "set",
            "status",
            "type",
            "vary"
        ];
        toWrap.forEach(function (f) {
            wrapper[f] = function () {
                node.warn(RED._("httpin.errors.deprecated-call", {
                        method: "msg.res." + f
                    }));
                var result = res[f].apply(res, arguments);
                if (result === res) {
                    return wrapper;
                } else {
                    return result;
                }
            }
        });
        return wrapper;
    }

    function HTTPInCustom(n) {
        RED.nodes.createNode(this, n);
        if (!n.url) {
            this.warn(RED._("httpin.errors.missing-path"));
            return;
        }
        var node = this;
		
		/** create the new express server **/
		var httpNode = express();
		httpNode.set('port', n.port);
		var httpServer = null;
		try{
			httpServer = httpNode.listen(httpNode.get('port'), function() {
				console.log('NodeRED http custom port node server listening on port ' + httpServer.address().port);
			});
			httpServer.on("error", function(err){
				node.status("Cannot create server, restart nodered");
				console.log("Error starting up express " + err);
			});
		} catch(e){
			node.status("Cannot create server, restart nodered");
			console.log(e);
		}
		
		/** this is copied from outside the function normally but we probably need it for every server started **/
		var corsHandler = function (req, res, next) {
			next();
		}

		if (RED.settings.httpNodeCors) {
			corsHandler = cors(RED.settings.httpNodeCors);
			httpNode.options("*", corsHandler);
		}

        this.url = n.url;
        if (this.url[0] !== '/') {
            this.url = '/' + this.url;
        }
        this.method = n.method;
        this.upload = n.upload;
        this.rawJson = n.rawJson;

        this.swaggerDoc = n.swaggerDoc;


        this.errorHandler = function (err, req, res, next) {
            node.warn(err);
            res.sendStatus(500);
        };

        this.callback = function (req, res) {
            var msgid = RED.util.generateId();
            res._msgid = msgid;
            if (node.method.match(/^(post|delete|put|options|patch)$/)) {
                node.send({
                    _msgid: msgid,
                    req: req,
                    res: createResponseWrapper(node, res),
                    payload: req.body
                });
            } else if (node.method == "get") {
                node.send({
                    _msgid: msgid,
                    req: req,
                    res: createResponseWrapper(node, res),
                    payload: req.query
                });
            } else {
                node.send({
                    _msgid: msgid,
                    req: req,
                    res: createResponseWrapper(node, res)
                });
            }
        };

        var httpMiddleware = function (req, res, next) {
            next();
        }

        if (RED.settings.httpNodeMiddleware) {
            if (typeof RED.settings.httpNodeMiddleware === "function" || Array.isArray(RED.settings.httpNodeMiddleware)) {
                httpMiddleware = RED.settings.httpNodeMiddleware;
            }
        }

        var maxApiRequestSize = RED.settings.apiMaxLength || '5mb';
        var jsonParser = bodyParser.json({
                limit: maxApiRequestSize
            });
        var urlencParser = bodyParser.urlencoded({
                limit: maxApiRequestSize,
                extended: true
            });

        var metricsHandler = function (req, res, next) {
            next();
        }
        if (this.metric()) {
            metricsHandler = function (req, res, next) {
                var startAt = process.hrtime();
                onHeaders(res, function () {
                    if (res._msgid) {
                        var diff = process.hrtime(startAt);
                        var ms = diff[0] * 1e3 + diff[1] * 1e-6;
                        var metricResponseTime = ms.toFixed(3);
                        var metricContentLength = res.getHeader("content-length");
                        //assuming that _id has been set for res._metrics in HttpOut node!
                        node.metric("response.time.millis", {
                            _msgid: res._msgid
                        }, metricResponseTime);
                        node.metric("response.content-length.bytes", {
                            _msgid: res._msgid
                        }, metricContentLength);
                    }
                });
                next();
            };
        }

        var multipartParser = function (req, res, next) {
            next();
        }
        if (this.upload) {
            var mp = multer({
                    storage: multer.memoryStorage()
                }).any();
            multipartParser = function (req, res, next) {
                mp(req, res, function (err) {
                    req._body = true;
                    next(err);
                })
            };
        }

        if (this.method == "get") {
            httpNode.get(this.url, cookieParser(), httpMiddleware, corsHandler, metricsHandler, this.callback, this.errorHandler);
        } else if (this.method == "post") {
            if (this.rawJson)
                     httpNode.post(this.url, bodyParser.text({ type: '*/*' }), this.callback, this.errorHandler);
               else  httpNode.post(this.url, cookieParser(), httpMiddleware, corsHandler, metricsHandler, jsonParser, urlencParser, multipartParser, rawBodyParser, this.callback, this.errorHandler);     
        } else if (this.method == "put") {
            if (this.rawJson)
                 httpNode.put(this.url, bodyParser.text({ type: '*/*' }), this.callback, this.errorHandler);
            else httpNode.put(this.url, cookieParser(), httpMiddleware, corsHandler, metricsHandler, jsonParser, urlencParser, rawBodyParser, this.callback, this.errorHandler);
        } else if (this.method == "patch") {
            httpNode.patch(this.url, cookieParser(), httpMiddleware, corsHandler, metricsHandler, jsonParser, urlencParser, rawBodyParser, this.callback, this.errorHandler);
        } else if (this.method == "delete") {
            httpNode.delete(this.url, cookieParser(), httpMiddleware, corsHandler, metricsHandler, jsonParser, urlencParser, rawBodyParser, this.callback, this.errorHandler);
        }

        this.on('close', function (removed, done) {
            var node = this;
            /*httpNode._router.stack.forEach(function (route, i, routes) {
                if (route.route && route.route.path === node.url && route.route.methods[node.method]) {
                    routes.splice(i, 1);
                }
            });*/
			httpServer.close(function() {
				console.log("Shutdown express server for NodeRED http custom port node "); 
				done();
			});
        });

    }
    RED.nodes.registerType("node-red-contrib-http-custom-port", HTTPInCustom);

}
