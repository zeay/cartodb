'use strict';
var debug = require('debug')('cartodb');
var debugUpload = require('debug')('cartodb:upload');
var qs = require('querystringparser');
var url = require('url');
var https = require('https');
var stream = require('readable-stream');
var PassThrough = stream.PassThrough;
var JSONStream = require('jsonstream3');
var methods = require('./methods');
var Builder = require('./builder');
var Promise = require('bluebird');
var debugBatch = require('debug')('cartodb:batch');
var debugrs = require('debug')('cartodb:readstream');
var createWriteStream = require('./write-stream');
module.exports = function (user, key, opts) {
  var client = new CartoDB(user, key, opts);
  function cartodb(tableName) {
    var qb = client.queryBuilder();
    return tableName ? qb.table(tableName) : qb;
  }
  cartodb.raw = function raw() {
    return client.raw.apply(client, arguments);
  };
  cartodb.createWriteStream = createWriteStream(cartodb);
  methods.forEach(function (method) {
    cartodb[method] = function () {
      var builder = client.queryBuilder();
      return builder[method].apply(builder, arguments);
    };
  });
  Object.defineProperties(cartodb, {
    schema: {
      get: function get() {
        return client.schemaBuilder();
      }
    }
  });
  return cartodb;
};

function CartoDB(user, key, opts) {
  this.url = createBaseUrl(user, opts);
  this.key = key;
  this.isBatch = false;
  this.jobs = new Set();
  this.exiting = false;
  this.jobCB = createJobCB(this)
  process.on('exit', ()=>{
    if (this.jobs.size) {
      console.log('batch jobs');
      for (let job of this.jobs) {
        console.log(job);
      }
    }
  })
}
CartoDB.prototype.batch = function () {
  this.isBatch = true;
  return this;
}
CartoDB.prototype.onSuccess = function (query) {
  if (typeof query === 'string') {
    this._onSuccess = query;
  } else {
    this._onSuccess = query.toString();
  }
  return this;
}
CartoDB.prototype.onError = function (query) {
  if (typeof query === 'string') {
    this._onError = query;
  } else {
    this._onError = query.toString();
  }
  return this;
}
function createBaseUrl (user, opts) {
  if (!opts || (!opts.domain && !opts.subdomainless)) {
    return `https://${user}.carto.com/api/v2/sql`;
  }
  if (opts.domain) {
    if (opts.subdomainless) {
      return `https://${opts.domain}/user/${user}/api/v2/sql`;
    } else {
      return `https://${user}.${opts.domain}/api/v2/sql`;
    }
  } else if (opts.subdomainless) {
    return `https://carto.com/user/${user}/api/v2/sql`;
  }
}
CartoDB.prototype.request = function (sql) {
  var out = new PassThrough();
  var query = qs.stringify({
    api_key: this.key,
    q: sql
  });
  var opts = url.parse(this.url);
  opts.method = 'POST';
  opts.headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': query.length
  };
  makeRequest(opts, out, query);
  return out;
};
function makeRequest(opts, out, query) {
  var returned = false;
  var retried = false;
  debugUpload('making request');
  var req = https.request(opts, function (resp) {
    returned = true;
    if (retried) {
      return;
    }
    out.emit('headers', resp.headers);
    out.emit('code', resp.statusCode);
    debug('code: ' + resp.statusCode);
    resp.on('error', function (e) {
      out.emit('error', e);
    });
    resp.pipe(out);
  });
  req.on('error', function (e) {
    debugUpload('error ' + e && e.stack || e);
    if (returned) {
      debugUpload('already returned not retrying');
      return;
    }
    debugUpload('going to retry');
    retried = true;
    makeRequest(opts, out, query);
  });
  req.end(query);
}
CartoDB.prototype.createReadStream = function (sql) {
  var out = JSONStream.parse('rows.*');
  //var out = new PassThrough();
  this.request(sql).on('error', function (e) {
    out.emit('error', e);
  }).on('headers', function (e) {
    out.emit('headers', e);
  }).on('code', function (e) {
    if (e > 299) {
      var data = [];
      this.on('data', function (d) {
        data.push(d);
      }).on('finish', function () {
        var err = Buffer.concat(data).toString();
        debugrs(err);
        debugrs(sql);
        out.emit('error', new Error(err));
      });
    } else {
      this.pipe(out);
    }
    out.emit('code', e);
  });
  return out;
};
function quickReq(opts, data) {
  return new Promise(function (yes, no) {
    var req = https.request(opts, function (res) {
      var out = '';
      res.on('data', function (d) {
        out += d.toString();
      });
      res.on('end', function () {
        var json;
        if (res.statusCode > 299) {
          return no(new Error(out));
        }
        try {
          json = JSON.parse(out);
        } catch (e) {
          return no(new Error(out));
        }
        if (json) {
          yes(json);
        } else {
          no(new Error(out));
        }
      });
      res.on('error', function (e) {
        no(e);
      });
    });
    req.on('error', function (e) {
      no(e);
    });
    if (data) {
      req.write(data);
    }
    req.end();
  });
}
function get(url) {
  return new Promise(function (yes, no) {
    https.get(url, function (res) {
      var out = '';
      res.on('data', function (d) {
        out += d.toString();
      });
      res.on('end', function () {
        var json;
        if (res.statusCode > 299) {
          return no(new Error(out));
        }
        try {
          json = JSON.parse(out);
        } catch (e) {
          return no(new Error(out));
        }
        if (json) {
          yes(json);
        } else {
          no(new Error(out));
        }
      });
      res.on('error', function (e) {
        no(e);
      });
    }).on('error', no);
  });
}
function poll(url, num) {
  debugBatch('polling');
  return Promise.delay(50).then(function () {
    return get(url).then(function (resp) {
      debugBatch(JSON.stringify(resp));
      if (resp.status === 'done') {
        return {
          ok: true
        };
      }
      if (resp.status === 'pending' || resp.status === 'running') {
        return poll(url);
      }
      if (resp.query && resp.query.query && resp.query.query.length) {
        let query = resp.query.query[0];
        if (query.failed_reason) {
          throw new Error(query.failed_reason);
        }
      }
      throw new Error(resp.failed_reason || `query failed with status "${resp.status}"`);
    }, e=> {
      if (e && e.code && e.code === 'ETIMEDOUT') {
        num = num || 0;
        if (num >= 3) {
          throw e;
        }
        return poll(url, num + 1);
      }
      throw e;
    });
  })
}
function createDelete(self, job) {
  let opts = url.parse(self.url + '/job/' + job + '?' + qs.stringify({
    api_key: self.key
  }))
  opts.method = 'delete'
  return quickReq(opts)
}
function makeDelete(self, jobs) {
  return new Promise(function (yes) {
    let toFinish = jobs.length
    jobs.forEach(function (job) {
      createDelete(self, job).then(function () {
        toFinish--;
        console.log('canceled', job);
        self.jobs.delete(job);
        if (!toFinish) {
          yes();
        }
      }, function () {
        toFinish--;
        console.log('error canceling', job)
        if (!toFinish) {
          yes();
        }
      })
    })
  });
}

function createJobCB(self) {
  return jobCB;
  function jobCB() {
    if (self.exiting) {
      console.log('good bye');
      process.exit();
    }
    self.exiting = true;
    if (!self.jobs.size) {
      return;
    }
    let jobs = Array.from(self.jobs);
    console.log(`there are ${jobs.length} batch jobs still in progress`);
    for (let job in jobs) {
      console.log(job)
    }
    console.log('deleting');
    makeDelete(self, jobs).then(function () {
      console.log('all set');
      process.exit();
    })
  }
}
CartoDB.prototype.startBatch = function(id) {
  if (this.jobs.has(id)) {
    return;
  }
  debugBatch('starting batch', id);
  this.jobs.add(id);
  if (this.jobs.size === 1) {
    process.on('SIGINT', this.jobCB);
  }
}
CartoDB.prototype.cleanupBatch = function  (id) {
  if (!this.jobs.has(id)) {
    return;
  }
  debugBatch('finished batch', id)
  this.jobs.delete(id);
  if (!this.jobs.size) {
    process.removeListener('SIGINT', this.jobCB);
  }
}
CartoDB.prototype.batchQuery = function (sql, callback) {
  debugBatch(sql)
  var innerQuery = {
    query: sql
  };
  if (this._onSuccess) {
    innerQuery.onsuccess = this._onSuccess;
  }
  if (this._onError) {
    innerQuery.onerror = this._onError;
  }

  var query = JSON.stringify({
    query: {
      query: [innerQuery]
    }
  });
  var thisUrl = this.url + '/job?' + qs.stringify({
    api_key: this.key
  });
  var opts = url.parse(thisUrl);
  opts.method = 'POST';
  opts.headers = {
    'Content-Type': 'application/json',
    'Content-Length': query.length
  };
  var self = this;
  let id;
  return quickReq(opts, query).then(function (data) {
    id = data.job_id
    self.startBatch(data.job_id);
    return poll(self.url + '/job/' + data.job_id + '?' + qs.stringify({
      api_key: self.key
    }));
  }).then(function (resp) {
    self.cleanupBatch(id);
    process.nextTick(function () {
      callback(null, resp);
    })
  }).catch(function (e) {
    if (id) {
      self.cleanupBatch(id);
    }
    process.nextTick(function () {
      callback(e);
    })
  })
}
CartoDB.prototype.query = function (sql, callback) {
  var out = [];
  var called = false;
  this.createReadStream(sql).on('data', function (d) {
    out.push(d);
  }).on('error', function (e) {
    if (called) {
      return;
    }
    called = true;
    callback(e);
  }).on('finish', function () {
    process.nextTick(function () {
      if (called) {
        return;
      }
      called = true;
      callback(null, out);
    });
  });
};
CartoDB.prototype.exec = function (sql, cb) {
  debug(sql);
  if (typeof cb === 'function') {
    if (this.isBatch) {
      this.isBatch = false;
      return this.batchQuery(sql, cb);
    }
    return this.query(sql, cb);
  } else {
    return this.createReadStream(sql);
  }
};
CartoDB.prototype.QueryCompiler = require('./compiler');
CartoDB.prototype.queryCompiler = function queryCompiler(builder) {
  return new this.QueryCompiler(this, builder);
};
CartoDB.prototype.QueryBuilder = require('./builder');
CartoDB.prototype.queryBuilder = function queryBuilder() {
  return new this.QueryBuilder(this);
};
CartoDB.prototype.Raw = require('./raw');
CartoDB.prototype.raw = function _raw() {
  var raw = new this.Raw(this);
  return raw.set.apply(raw, arguments);
};

CartoDB.prototype.SchemaBuilder = require('./schema/builder');
CartoDB.prototype.schemaBuilder = function schemaBuilder() {
  return new this.SchemaBuilder(this);
};

CartoDB.prototype.SchemaCompiler = require('./schema/compiler');
CartoDB.prototype.schemaCompiler = function schemaCompiler(builder) {
  return new this.SchemaCompiler(this, builder);
};

CartoDB.prototype.TableBuilder = require('./schema/tablebuilder');
CartoDB.prototype.tableBuilder = function tableBuilder(type, tableName, fn) {
  return new this.TableBuilder(this, type, tableName, fn);
};

CartoDB.prototype.TableCompiler = require('./schema/tablecompiler');
CartoDB.prototype.tableCompiler = function tableCompiler(tableBuilder) {
  return new this.TableCompiler(this, tableBuilder);
};

CartoDB.prototype.ColumnBuilder = require('./schema/columnbuilder');
CartoDB.prototype.columnBuilder = function columnBuilder(tableBuilder, type, args) {
  return new this.ColumnBuilder(this, tableBuilder, type, args);
};

CartoDB.prototype.ColumnCompiler = require('./schema/columncompiler');
CartoDB.prototype.columnCompiler = function columnCompiler(tableBuilder, columnBuilder) {
  return new this.ColumnCompiler(this, tableBuilder, columnBuilder);
};

CartoDB.prototype.Formatter = require('./formatter');
CartoDB.prototype.formatter = function formatter() {
  return new this.Formatter(this);
};

CartoDB.prototype.wrapIdentifier = function wrapIdentifier(value) {
  if (value === '*') {
    return value;
  }
  var matched = value.match(/(.*?)(\[[0-9]\])/);
  if (matched) {
    return this.wrapIdentifier(matched[1]) + matched[2];
  }
  return '"' + value.replace(/"/g, '""') + '"';
};

methods.forEach(function (method) {
  CartoDB.prototype[method] = function () {
    var builder = new Builder(this);
    return builder[method].apply(builder, arguments);
  };
});
