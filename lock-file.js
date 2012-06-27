var fs = require('fs')

var wx = 'wx'
if (process.version.match(/^v0.[456]/)) {
  var c = require('constants')
  wx = c.O_TRUNC | c.O_CREAT | c.O_WRONLY | c.O_EXCL
}

var locks = {}

process.on('exit', function () {
  console.error('lock exit')
  // cleanup
  Object.keys(locks).forEach(exports.unlockSync)
})

// XXX https://github.com/joyent/node/issues/3555
// Remove when node 0.8 is deprecated.
process.on('uncaughtException', function H (er) {
  var l = process.listeners('uncaughtException').filter(function (h) {
    return h !== H
  })
  if (!l.length) {
    // cleanup
    Object.keys(locks).forEach(exports.unlockSync)
    process.removeListener(H)
    throw er
  }
})

exports.unlock = function (path, cb) {
  // best-effort.  unlocking an already-unlocked lock is a noop
  fs.unlink(path, function (unlinkEr) {
    if (!locks.hasOwnProperty(path)) return cb()
    fs.close(locks[path], function (closeEr) {
      delete locks[path]
      cb()
    })
  })
}

exports.unlockSync = function (path) {
  try { fs.unlinkSync(path) } catch (er) {}
  if (!locks.hasOwnProperty(path)) return
  // best-effort.  unlocking an already-unlocked lock is a noop
  try { fs.close(locks[path]) } catch (er) {}
  delete locks[path]
}


// if the file can be opened in readonly mode, then it's there.
// if the error is something other than ENOENT, then it's not.
exports.check = function (path, opts, cb) {
  if (typeof opts === 'function') cb = opts, opts = {}
  fs.open(path, 'r', function (er, fd) {
    if (er) {
      if (er.code !== 'ENOENT') return cb(er)
      return cb(null, false)
    }

    if (!opts.stale) {
      return fs.close(fd, function (er) {
        return cb(er, true)
      })
    }

    fs.fstat(fd, function (er, st) {
      if (er) return fs.close(fd, function (er2) {
        return cb(er)
      })

      fs.close(fd, function (er) {
        var age = Date.now() - st.ctime.getTime()
        return cb(er, age <= opts.stale)
      })
    })
  })
}

exports.checkSync = function (path, opts) {
  opts = opts || {}
  if (opts.wait) {
    throw new Error('opts.wait not supported sync for obvious reasons')
  }

  try {
    var fd = fs.openSync(path, 'r')
  } catch (er) {
    if (er.code !== 'ENOENT') throw er
    return false
  }

  if (!opts.stale) {
    fs.closeSync(fd)
    return true
  }

  // file exists.  however, might be stale
  if (opts.stale) {
    try {
      var st = fs.fstatSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    var age = Date.now() - st.ctime.getTime()
    return (age <= opts.stale)
  }
}



exports.lock = function (path, opts, cb) {
  if (typeof opts === 'function') cb = opts, opts = {}
  // try to engage the lock.
  // if this succeeds, then we're in business.
  fs.open(path, wx, function (er, fd) {
    if (!er) {
      locks[path] = fd
      return cb(null, fd)
    }

    // something other than "currently locked"
    // maybe eperm or something.
    if (er.code !== 'EEXIST') return cb(er)

    // someone's got this one.  see if it's valid.
    if (opts.stale) {
      return fs.stat(path, function (er, st) {
        var age = Date.now() - st.ctime.getTime()
        if (age > opts.stale) {
          exports.unlock(path, function (er) {
            if (er) return cb(er)
            var opts_ = Object.create(opts, { stale: { value: false }})
            exports.lock(path, opts_, cb)
          })
        }
      })
    } else if (opts.wait) {
      // wait for some ms for the lock to clear
      var watcher = fs.watch(path, function (change) {
        if (change === 'rename') {
          // ok, try and get it now.
          watcher.close()
          clearTimeout(timer)
          var opts_ = Object.create(opts, { wait: { value: false }})
          exports.lock(path, opts_, cb)
        }
      })
      var timer = setTimeout(function () {
        watcher.close()
        cb(er)
      }, opts.wait)
    } else {
      // failed to lock!
      return cb(er)
    }
  })
}

exports.lockSync = function (path, opts) {
  opts = opts || {}
  if (opts.wait) {
    throw new Error('opts.wait not supported sync for obvious reasons')
  }

  try {
    var fd = fs.openSync(path, wx)
    locks[path] = fd
    return fd
  } catch (er) {
    if (er.code !== 'EEXIST') throw er

    if (opts.stale) {
      var st = fs.statSync(path)
      var age = Date.now() - st.ctime.getTime()
      if (age > opts.stale) {
        exports.unlockSync(path)
        var opts_ = Object.create(opts, { stale: { value: false }})
        return exports.lockSync(path, opts_)
      }
    }

    // failed to lock!
    throw er
  }
}