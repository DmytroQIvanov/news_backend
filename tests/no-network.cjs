// Test fixtures may replace fetch/lookup explicitly; accidental live I/O always fails locally.
const blocked = () => { throw new Error('Live network I/O is disabled in tests; provide a fixture'); };
globalThis.fetch = blocked;
require('node:net').Socket.prototype.connect = blocked;
// Existing HTTP fixtures assume a public DNS answer; explicit rebinding tests inject their own answers.
const answer = options => options?.all ? [{ address: '93.184.216.34', family: 4 }] : { address: '93.184.216.34', family: 4 };
require('node:dns').promises.lookup = async (_host, options) => answer(options);
require('node:dns').lookup = (_host, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {}; }
  queueMicrotask(() => options?.all ? callback(null, answer(options)) : callback(null, '93.184.216.34', 4));
};
