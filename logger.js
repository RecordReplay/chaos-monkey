function log(...args) {
  console.log(...args)
}

function logError(...args) {
  console.error(...args)
}

function logException(...args) {
  console.error(...args)
}

module.exports = {
  log,
  logError,
  logException
}