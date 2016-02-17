'use strict';

const common = require('_http_common');
const HTTPParser = require('_http_parser');
const net = require('net');
const parsers = common.parsers;
const httpSocketSetup = common.httpSocketSetup;
const debug = common.debug;
const assert = require('assert').ok;

function HTTPParserResponse(socket) {
  httpSocketSetup(socket);

  const self = this;
  const parser = parsers.alloc();
  let outgoingData = 0;

  parser.reinitialize(HTTPParser.REQUEST);
  parser.socket = socket;
  socket.parser = parser;
  parser.incoming = null;

  this.parser = parser;

  //TODO(tomgco): setup callback, eventually make this event driven
  parser.onIncoming = null;

  // Attaching listeners to socket.
  // we are using `.addListener` here as we are overriding `.on` later.
  socket.addListener('error', socketOnError);
  socket.addListener('close', serverSocketCloseListener);
  socket.addListener('close', () => this.emit('close'));

  // TODO(tomgco): Move into an event in Parser
  // we need to have an event from the parser which states when we are
  // receiving data, parser.on('incoming', (upgrade) => ...);
  parser.onIncoming = parserOnIncoming;

  // end, data, resume, pause, drain
  socket.on('end', socketOnEnd);
  socket.on('data', socketOnData);
  socket.on('drain', socketOnDrain);

  // We are consuming a socket, so it won't get any data.
  socket.on('resume', onSocketResume);
  socket.on('pause', onSocketPause);

  socket.on = socketOnWrap;

  // Legacy code, seems fragile. Maybe we can update sockets with an api that
  // allows us to check for an externalStream.
  var external = socket._handle._externalStream;
  if (external) {
    // TODO(tomgco): Break out into the consume function.
    parser._consumed = true;
    parser.consume(external);
  }
  external = null;

  // TODO(tomgco): This will be moved to HTTPParser to become an event on which
  // we can listen to.
  parser[kOnExecute] = onParserExecute;

  // The following callback is issued after the headers have been read on a
  // new message. In this callback we setup the response object and pass it
  // to the user.

  socket._paused = false;

  function socketOnDrain() {
    const socket = this;
    var needPause = outgoingData > socket._writableState.highWaterMark;

    // If we previously paused, then start reading again.
    if (socket._paused && !needPause) {
      socket._paused = false;
      if (socket.parser)
        socket.parser.resume();
      socket.resume();
    }
  }

  function updateOutgoingData(delta) {
    const socket = this.socket;
    // `outgoingData` is an approximate amount of bytes queued through all
    // inactive responses. If more data than the high watermark is queued - we
    // need to pause TCP socket/HTTP parser, and wait until the data will be
    // sent to the client.
    outgoingData += delta;
    if (socket._paused && outgoingData < socket._writableState.highWaterMark)
      return socketOnDrain();
  }

  function socketOnEnd() {
    var socket = this;
    var ret = this.parser.finish();

    if (ret instanceof Error) {
      debug('parse error');
      socketOnError.call(socket, ret);
      return;
    }

    // TODO(tomgco): Move this back to _http_server as self references `Server`
    if (!self.httpAllowHalfOpen) {
      abortIncoming();
      if (socket.writable) socket.end();
    } else if (outgoing.length) {
      outgoing[outgoing.length - 1]._last = true;
    } else if (socket._httpMessage) {
      socket._httpMessage._last = true;
    } else {
      if (socket.writable) socket.end();
    }
  }

  function socketOnError(e) {
    // Ignore further errors
    this.removeListener('error', socketOnError);
    this.on('error', () => {});

    // TODO(tomgco): emit from this class so that _http_server can handle this.
    self.emit()
    if (!self.emit('clientError', e, this))
      this.destroy(e);
  }

  function onParserExecuteCommon(ret, d) {
    if (ret instanceof Error) {
      debug('parse error');
      socketOnError.call(socket, ret);
    } else if (parser.incoming && parser.incoming.upgrade) {
      // Upgrade or CONNECT
      var bytesParsed = ret;
      var req = parser.incoming;
      debug('SERVER upgrade or connect', req.method);

      if (!d)
        d = parser.getCurrentBuffer();

      socket.removeListener('data', socketOnData);
      socket.removeListener('end', socketOnEnd);
      socket.removeListener('close', serverSocketCloseListener);
      unconsume(parser, socket);
      parser.finish();
      parser(req, null);
      parser = null;

      var eventName = req.method === 'CONNECT' ? 'connect' : 'upgrade';
      // TODO(tomgco) emit to _http_server
      if (self.listenerCount(eventName) > 0) {
        debug('SERVER have listener for %s', eventName);
        var bodyHead = d.slice(bytesParsed, d.length);

        // TODO(isaacs): Need a way to reset a stream to fresh state
        // IE, not flowing, and not explicitly paused.
        socket._readableState.flowing = null;
        self.emit(eventName, req, socket, bodyHead);
      } else {
        // Got upgrade header or CONNECT method, but have no handler.
        socket.destroy();
      }
    }

    if (socket._paused && socket.parser) {
      // onIncoming paused the socket, we should pause the parser as well
      debug('pause parser');
      socket.parser.pause();
    }
  }
}

function serverSocketCloseListener() {
  debug('server socket close');
  // mark this parser as reusable
  if (this.parser) {
    this.parser(null, this);
  }

  // TODO(tomgco): Emitting close on this class and handle in _http_server
  // abortIncoming();
}

function socketOnData(d) {
  const socket = this;
  assert(!socket._paused);
  debug('SERVER socketOnData %d', d.length);
  var ret = socket.parser.execute(d);

  onParserExecuteCommon(ret, d);
}

function onParserExecute(ret, d) {
  debug('SERVER socketOnParserExecute %d', ret);
  onParserExecuteCommon(ret, undefined);
}

function onSocketResume() {
  // It may seem that the socket is resumed, but this is an enemy's trick to
  // deceive us! `resume` is emitted asynchronously, and may be called from
  // `incoming.readStart()`. Stop the socket again here, just to preserve the
  // state.
  //
  // We don't care about stream semantics for the consumed socket anyway.
  if (this._paused) {
    this.pause();
    return;
  }

  if (this._handle && !this._handle.reading) {
    this._handle.reading = true;
    this._handle.readStart();
  }
}

function onSocketPause() {
  if (this._handle && this._handle.reading) {
    this._handle.reading = false;
    this._handle.readStop();
  }
}

function unconsume(parser, socket) {
  if (socket._handle) {
    if (parser._consumed)
      parser.unconsume(socket._handle._externalStream);
    parser._consumed = false;
    socket.removeListener('pause', onSocketPause);
    socket.removeListener('resume', onSocketResume);
  }
}

function socketOnWrap(ev, fn) {
  var res = net.Socket.prototype.on.call(this, ev, fn);
  if (!this.parser) {
    this.on = net.Socket.prototype.on;
    return res;
  }

  if (ev === 'data' || ev === 'readable')
    unconsume(this.parser, this);

  return res;
}

module.exports = HTTPParserResponse;
