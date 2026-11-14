// Runs in the page before the game does, with nothing of Node within the
// page's reach. It tells the page two things: that it is inside the Mac app,
// and, when the page is the copy packed into the app, which game socket to
// use. A page loaded from the game's own server is given no socket address
// and uses its own origin, as in a browser.

const { contextBridge } = require('electron');

const PREFIX = '--orbit-server-url=';
const argument = process.argv.find((value) => value.startsWith(PREFIX));
contextBridge.exposeInMainWorld('orbitApp', {
  serverUrl: argument ? argument.slice(PREFIX.length) : null,
});
