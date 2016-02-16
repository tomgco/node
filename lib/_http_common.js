'use strict';

const FreeList = require('internal/freelist').FreeList;
const HTTPParseStream = require('_http_parser');
const HTTPParser = process.binding('http_parser').HTTPParser;

const incoming = require('_http_incoming');
const IncomingMessage = incoming.IncomingMessage;
const readStart = incoming.readStart;
const readStop = incoming.readStop;

const debug = require('util').debuglog('http');
exports.debug = debug;

exports.CRLF = '\r\n';
exports.chunkExpression = /chunk/i;
exports.continueExpression = /100-continue/i;

var parsers = new FreeList('parsers', 1000, function() {
  return new HTTPParseStream(HTTPParseStream.REQUEST);
});
exports.parsers = parsers;

exports.methods = HTTPParser.methods;


function ondrain() {
  if (this._httpMessage) this._httpMessage.emit('drain');
}


function httpSocketSetup(socket) {
  socket.removeListener('drain', ondrain);
  socket.on('drain', ondrain);
}
exports.httpSocketSetup = httpSocketSetup;

/**
 * Verifies that the given val is a valid HTTP token
 * per the rules defined in RFC 7230
 **/
const token = /^[a-zA-Z0-9_!#$%&'*+.^`|~-]+?$/;
function checkIsHttpToken(val) {
  return typeof val === 'string' && token.test(val);
}
exports._checkIsHttpToken = checkIsHttpToken;
