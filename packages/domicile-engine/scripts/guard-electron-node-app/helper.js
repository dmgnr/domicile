// A module of the app's own, which the preload and the page each require by a
// relative path, as Node resolves it from the requiring file's directory.
// biome-ignore lint/style/noCommonJs: Node's require loads it, as in Electron.
module.exports = { answer: 42 };
