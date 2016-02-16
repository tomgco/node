const HTTPParser = requre('_http_parser');

function HTTPParserResponse(socket) {
  httpSocketSetup(socket);

  const parser = parsers.alloc();
  parser.reinitialize(HTTPParser.REQUEST);
  parser.socket = socket;
  socket.parser = parser;
  parser.incoming = null;

  this.parser = parser;

  parser.onIncoming = null; //TODO setup callback, eventually make this event driven
}

module.exports = HTTPParserResponse;
