
// Table Compiler
// -------
'use strict';

var helpers = require('./helpers');
var normalizeArr = require('../normalizeArr');
var debug = require('debug')('cartodb:tablecompiler');
var isEmpty = require('../isEmpty');

function TableCompiler(client, tableBuilder) {
  this.client = client;
  this.method = tableBuilder._method;
  this.tableNameRaw = tableBuilder._tableName;
  this.single = tableBuilder._single;
  var grouped = this.grouped = {};
  tableBuilder._statements.forEach(function (item) {
    if (!item.grouping) {
      return;
    }
    var val = item.grouping;
    if (!(val in grouped)) {
      grouped[val] = [];
    }
    grouped[val].push(item);
  });
  this.formatter = client.formatter();
  this.sequence = [];
}

TableCompiler.prototype.pushQuery = helpers.pushQuery;

TableCompiler.prototype.pushAdditional = helpers.pushAdditional;

// Convert the tableCompiler toSQL
TableCompiler.prototype.toSQL = function () {
  this[this.method]();
  return this.sequence;
};

// Column Compilation
// -------

// If this is a table "creation", we need to first run through all
// of the columns to build them into a single string,
// and then run through anything else and push it to the query sequence.
TableCompiler.prototype.create = function (ifNot) {
  var columns = this.getColumns();
  var columnTypes = this.getColumnTypes(columns);
  this.createQuery(columnTypes, ifNot);
  this.columnQueries(columns);
  delete this.single.comment;
  this.alterTable();
};

// Only create the table if it doesn't exist.
TableCompiler.prototype.createIfNot = function () {
  this.create(true);
};

// If we're altering the table, we need to one-by-one
// go through and handle each of the queries associated
// with altering the table's schema.
TableCompiler.prototype.alter = function () {
  var columns = this.getColumns();
  var columnTypes = this.getColumnTypes(columns);
  this.addColumns(columnTypes);
  this.columnQueries(columns);
  this.alterTable();
};

TableCompiler.prototype.foreign = function (foreignData) {
  if (foreignData.inTable && foreignData.references) {
    var keyName = this._indexCommand('foreign', this.tableNameRaw, foreignData.column);
    var column = this.formatter.columnize(foreignData.column);
    var references = this.formatter.columnize(foreignData.references);
    var inTable = this.formatter.wrap(foreignData.inTable);
    var onUpdate = foreignData.onUpdate ? ' on update ' + foreignData.onUpdate : '';
    var onDelete = foreignData.onDelete ? ' on delete ' + foreignData.onDelete : '';
    this.pushQuery('alter table ' + this.tableName() + ' add constraint ' + keyName + ' ' + 'foreign key (' + column + ') references ' + inTable + ' (' + references + ')' + onUpdate + onDelete);
  }
};

// Get all of the column sql & bindings individually for building the table queries.
TableCompiler.prototype.getColumnTypes = function (columns) {
  return columns.map(function (item) {
    return item[0];
  }).reduce(function (memo, column) {
    memo.sql.push(column.sql);
    memo.bindings.concat(column.bindings);
    return memo;
  }, { sql: [], bindings: [] });
};

// Adds all of the additional queries from the "column"
TableCompiler.prototype.columnQueries = function (columns) {
  var queries = columns.map(function (item) {
    return item.slice(1);
  }).reduce(function (memo, column) {
    if (!isEmpty(column)) {
      return memo.concat(column);
    }
    return memo;
  }, []);
  for (var i = 0, l = queries.length; i < l; i++) {
    this.pushQuery(queries[i]);
  }
};

// Add a new column.
TableCompiler.prototype.addColumnsPrefix = 'add column ';

// All of the columns to "add" for the query
TableCompiler.prototype.addColumns = function (columns) {
  if (columns.sql.length > 0) {
    var columnSql = columns.sql.map(function (column) {
      return this.addColumnsPrefix + column;
    }, this);
    this.pushQuery({
      sql: 'alter table ' + this.tableName() + ' ' + columnSql.join(', '),
      bindings: columns.bindings
    });
  }
};

// Compile the columns as needed for the current create or alter table
TableCompiler.prototype.getColumns = function () {
  var i = -1,
      compiledColumns = [],
      columns = this.grouped.columns || [];
  while (++i < columns.length) {
    compiledColumns.push(this.client.columnCompiler(this, columns[i].builder).toSQL());
  }
  return compiledColumns;
};

TableCompiler.prototype.tableName = function () {
  return this.formatter.wrap(this.tableNameRaw);
};

// Generate all of the alter column statements necessary for the query.
TableCompiler.prototype.alterTable = function () {
  var alterTable = this.grouped.alterTable || [];
  for (var i = 0, l = alterTable.length; i < l; i++) {
    var statement = alterTable[i];
    if (this[statement.method]) {
      this[statement.method].apply(this, statement.args);
    } else {
      debug(statement.method + ' does not exist');
    }
  }
  for (var item in this.single) {
    if (typeof this[item] === 'function') {
      this[item](this.single[item]);
    }
  }
};

// Drop the index on the current table.
TableCompiler.prototype.dropIndex = function (value) {
  this.pushQuery('drop index' + value);
};

// Drop the unique
TableCompiler.prototype.dropUnique = TableCompiler.prototype.dropForeign = function () {
  throw new Error('Method implemented in the dialect driver');
};

TableCompiler.prototype.dropColumnPrefix = 'drop column ';
TableCompiler.prototype.dropColumn = function () {
  var columns = normalizeArr.apply(null, arguments);
  var drops = (Array.isArray(columns) ? columns : [columns]).map(function (column) {
    return this.dropColumnPrefix + this.formatter.wrap(column);
  }, this);
  this.pushQuery('alter table ' + this.tableName() + ' ' + drops.join(', '));
};

// If no name was specified for this index, we will create one using a basic
// convention of the table name, followed by the columns, followed by an
// index type, such as primary or index, which makes the index unique.
TableCompiler.prototype._indexCommand = function (type, tableName, columns) {
  if (!Array.isArray(columns)) {
    columns = columns ? [columns] : [];
  }
  var table = tableName.replace(/\.|-/g, '_');
  return (table + '_' + columns.join('_') + '_' + type).toLowerCase();
};

//postgres ones
// Compile a rename column command.
TableCompiler.prototype.renameColumn = function (from, to) {
  return this.pushQuery({
    sql: 'alter table ' + this.tableName() + ' rename ' + this.formatter.wrap(from) + ' to ' + this.formatter.wrap(to)
  });
};

TableCompiler.prototype.compileAdd = function (builder) {
  var table = this.formatter.wrap(builder);
  var columns = this.prefixArray('add column', this.getColumns(builder));
  return this.pushQuery({
    sql: 'alter table ' + table + ' ' + columns.join(', ')
  });
};

// Adds the "create" query to the query sequence.
TableCompiler.prototype.createQuery = function (columns, ifNot) {
  var createStatement = ifNot ? 'create table if not exists ' : 'create table ';
  this.pushQuery({
    sql: createStatement + this.tableName() + ' (' + columns.sql.join(', ') + ')',
    bindings: columns.bindings
  });
  if ('comment' in this.single) {
    this.comment(this.single.comment);
  }
};

// Compiles the comment on the table.
TableCompiler.prototype.comment = function (comment) { // eslint-disable-line  no-unused-vars
  this.pushQuery('comment on table ' + this.tableName() + ' is ' + '\'' + (this.single.comment || '') + '\'');
};

// Indexes:
// -------

TableCompiler.prototype.primary = function (columns) {
  this.pushQuery('alter table ' + this.tableName() + ' add primary key (' + this.formatter.columnize(columns) + ')');
};
TableCompiler.prototype.unique = function (columns, indexName) {
  indexName = indexName || this._indexCommand('unique', this.tableNameRaw, columns);
  this.pushQuery('alter table ' + this.tableName() + ' add constraint ' + indexName + ' unique (' + this.formatter.columnize(columns) + ')');
};
TableCompiler.prototype.index = function (columns, indexName, indexType) {
  indexName = indexName || this._indexCommand('index', this.tableNameRaw, columns);
  this.pushQuery('create index ' + indexName + ' on ' + this.tableName() + (indexType && ' using ' + indexType || '') + ' (' + this.formatter.columnize(columns) + ')');
};
TableCompiler.prototype.dropPrimary = function () {
  this.pushQuery('alter table ' + this.tableName() + ' drop constraint ' + this.tableNameRaw + '_pkey');
};
TableCompiler.prototype.dropIndex = function (columns, indexName) {
  indexName = indexName || this._indexCommand('index', this.tableNameRaw, columns);
  this.pushQuery('drop index ' + indexName);
};
TableCompiler.prototype.dropUnique = function (columns, indexName) {
  indexName = indexName || this._indexCommand('unique', this.tableNameRaw, columns);
  this.pushQuery('alter table ' + this.tableName() + ' drop constraint ' + indexName);
};
TableCompiler.prototype.dropForeign = function (columns, indexName) {
  indexName = indexName || this._indexCommand('foreign', this.tableNameRaw, columns);
  this.pushQuery('alter table ' + this.tableName() + ' drop constraint ' + indexName);
};
module.exports = TableCompiler;
