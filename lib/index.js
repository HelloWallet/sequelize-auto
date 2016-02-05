var Sequelize = require('sequelize');
var async = require('async');
var fs = require('fs');
var dialects = require('./dialects');
var _ = Sequelize.Utils._;

function AutoSequelize(database, username, password, options) {
  this.sequelize = new Sequelize(database, username, password, options || {});
  this.queryInterface = this.sequelize.getQueryInterface();
  this.options = {};
}

AutoSequelize.prototype.run = function(options, callback) {
  var self = this;
  var text = {};
  var tables = [];
  var _tables = {};
  var _foreignKeys = {};
  var dialect = dialects[self.sequelize.options.dialect];

  if (typeof options === "function") {
    callback = options;
    options = {};
  }

  options.global = options.global || 'Sequelize';
  options.local = options.local || 'sequelize';
  options.spaces = options.spaces || false;
  options.indentation = options.indentation || 1;
  options.directory = options.directory || './models';
  options.additional = options.additional || {}
  options.additional.freezeTableName = ! _.isUndefined(options.additional.freezeTableName) ? options.additional.freezeTableName : true;

  options.schema = options.schema;

  self.options = options;

  var sql = 'SELECT table_name FROM information_schema.tables WHERE table_schema = \''+options.schema+'\' AND table_type LIKE \'%TABLE\' AND table_name != \'spatial_ref_sys\'';

  this.queryInterface.sequelize.query(sql).then(function (__tables) {
    tables = options.tables ? _.intersection(__tables, options.tables) : __tables;
    async.each(tables, mapForeignKeys, mapTables)
  });

  function mapForeignKeys(table, fn) {
    if (! dialect) return fn()

    var sql = dialect.getForeignKeysQuery(table, options.schema)

    self.sequelize.query(sql, {type: self.sequelize.QueryTypes.SELECT, raw: true}).then(function (res) {
      _.each(res, function (ref) {
        var sourceColumn = ref.source_column || ref.from || "";
        var targetColumn = ref.target_column || ref.to || "";
        var targetTable  = ref.target_table || ref.table || "";
        var isForeignKey = ! _.isEmpty(_.trim(sourceColumn)) && ! _.isEmpty(_.trim(targetColumn));
        var isPrimaryKey = _.isFunction(dialect.isPrimaryKey) && dialect.isPrimaryKey(ref);
        if (isForeignKey || isPrimaryKey) {
          _foreignKeys[table] = _foreignKeys[table] || {}
          _foreignKeys[table][sourceColumn] = ref
        }
      });

      fn()
    }, mapTables);
  }

  function mapTables(err) {
    if (err) console.error(err)
    async.each(tables, mapTable, generateText)
  }
// c.column_default as "default",
  function mapTable(table, _callback){
    var sql = 'SELECT tc.constraint_type as "constraint", c.column_name as "field",  c.is_nullable as "null", CASE WHEN c.udt_name = \'hstore\' THEN c.udt_name ELSE c.data_type END as "type", (SELECT array_agg(e.enumlabel) FROM pg_catalog.pg_type t JOIN pg_catalog.pg_enum e ON t.oid=e.enumtypid WHERE t.typname=c.udt_name) AS "special" FROM information_schema.columns c LEFT JOIN information_schema.key_column_usage cu ON c.table_name = cu.table_name AND cu.column_name = c.column_name LEFT JOIN information_schema.table_constraints tc ON c.table_name = tc.table_name AND cu.column_name = c.column_name AND tc.constraint_type = \'PRIMARY KEY\'  WHERE c.table_name = \''+table+'\' AND c.table_schema = \''+options.schema+'\'';
    self.queryInterface.sequelize.query(sql).then(function(fields) {
      _tables[table] = fields[0]
      _callback(null);
    }, _callback);
  }

  function generateText(err) {
    if (err) console.error(err)

    var tableNames = _.keys(_tables);
    async.each(tableNames, function(table, _callback){
      var fields = _.keys(_tables[table])
          , spaces = '';

      for (var x = 0; x < options.indentation; ++x) {
        spaces += (options.spaces === true ? ' ' : "\t");
      }

      text[table] = "/* jshint indent: " + options.indentation + " */\n\n";
      text[table] += "module.exports = function(sequelize, Sequelize) {\n";
      text[table] += spaces + "return sequelize.define('" + table + "', {\n";

      _.each(fields, function(field, i){
        // Find foreign key
        var foreignKey = _foreignKeys[table] && _foreignKeys[table][field] ? _foreignKeys[table][field] : null
        if (_.isObject(foreignKey)) {
          _tables[table][field].foreignKey = foreignKey
        }

        // column's attributes
        var fieldAttr = _.keys(_tables[table][field]);
        _.each(fieldAttr, function(attr, y){
          if(attr === 'field'){
            var str;
            var tokens = _tables[table][field][attr].split('_');
            str = tokens[0];
            for(var x = 1; x < tokens.length; x++){
              str += tokens[x].substring(0,1).toUpperCase() + tokens[x].substring(1);
            }
            text[table] += spaces + spaces + str + ": {\n";
          }
        });

        // Serial key for postgres...
        var defaultVal = _tables[table][field].defaultValue;

        // ENUMs for postgres...
        if (_tables[table][field].type === "USER-DEFINED" && !! _tables[table][field].special) {
          _tables[table][field].type = "ENUM(" + _tables[table][field].special.map(function(f){ return "'" + f + "'"; }).join(',') + ")";
        }

        _.each(fieldAttr, function(attr, x){
          var isSerialKey = _tables[table][field].foreignKey && _.isFunction(dialect.isSerialKey) && dialect.isSerialKey(_tables[table][field].foreignKey)

          // We don't need the special attribute from postgresql describe table..
          if (attr === "special") {
            return true;
          }

          if (attr === "foreignKey") {
            if (isSerialKey) {
              text[table] += spaces + spaces + spaces + "autoIncrement: true";
            } else {
              text[table] += spaces + spaces + spaces + "references: {\n";
              text[table] += spaces + spaces + spaces + spaces + "model: \'" + _tables[table][field][attr].target_table + "\',\n"
              text[table] += spaces + spaces + spaces + spaces + "key: \'" + _tables[table][field][attr].target_column + "\'\n"
              text[table] += spaces + spaces + spaces + "}"
            }
          }
          else if (attr === "primaryKey") {
            if (_tables[table][field][attr] === true && _tables[table][field].hasOwnProperty('foreignKey') && !!_tables[table][field].foreignKey.isPrimaryKey)
              text[table] += spaces + spaces + spaces + "primaryKey: true";
            else return true
          }
          else if (attr === "allowNull") {
            text[table] += spaces + spaces + spaces + attr + ": " + _tables[table][field][attr];
          }
          else if (attr === "defaultValue") {
            var val_text = defaultVal;

            if(isSerialKey) return true

            if (_.isString(defaultVal)) {
              val_text = "'" + val_text + "'"
            }
            if(defaultVal === null) {
              return true;
            } else {
              text[table] += spaces + spaces + spaces + attr + ": " + val_text;
            }
          }
          else if (attr === "type" && _tables[table][field][attr].indexOf('ENUM') === 0) {
            text[table] += spaces + spaces + spaces + attr + ": Sequelize." + _tables[table][field][attr];
          } else {
            var _attr = (_tables[table][field][attr] || '').toLowerCase();
            var val = "'" + _tables[table][field][attr] + "'";
            if (_attr === "tinyint(1)" || _attr === "boolean") {
              val = 'Sequelize.BOOLEAN';
            }
            else if (_attr.match(/^(smallint|mediumint|tinyint|int)/)) {
              var length = _attr.match(/\(\d+\)/);
              val = 'Sequelize.INTEGER' + (!!length ? length : '');
            }
            else if (_attr.match(/^bigint/)) {
              val = 'Sequelize.BIGINT';
            }
            else if (_attr.match(/^string|varchar|varying|nvarchar/)) {
              val = 'Sequelize.STRING';
            }
            else if (_attr.match(/text|ntext$/)) {
              val = 'Sequelize.TEXT';
            }
            else if (_attr.match(/^(date|time)/)) {
              val = 'Sequelize.DATE';
            }
            else if (_attr.match(/^(float|float4)/)) {
              val = 'Sequelize.FLOAT';
            }
            else if (_attr.match(/^decimal/)) {
              val = 'Sequelize.DECIMAL';
            }
            else if (_attr.match(/^(float8|double precision)/)) {
              val = 'Sequelize.DOUBLE';
            }
            else if (_attr.match(/^uuid/)) {
              val = 'Sequelize.UUIDV4';
            }
            else if (_attr.match(/^json/)) {
              val = 'Sequelize.JSON';
            }
            else if (_attr.match(/^jsonb/)) {
              val = 'Sequelize.JSONB';
            }
            else if (_attr.match(/^geometry/)) {
              val = 'Sequelize.GEOMETRY';
            }
            text[table] += spaces + spaces + spaces + attr + ": " + val;
          }

          text[table] += ",";
          text[table] += "\n";
        });

        // removes the last `,` within the attribute options
        text[table] = text[table].trim().replace(/,+$/, '') + "\n";

        text[table] += spaces + spaces + "}";
        if ((i+1) < fields.length) {
          text[table] += ",";
        }
        text[table] += "\n";
      });

      text[table] += spaces + "}";

      //conditionally add additional options to tag on to orm objects
      var hasadditional = _.isObject(options.additional) && _.keys(options.additional).length > 0;

      text[table] += ", {\n";

      text[table] += spaces + spaces  + "underscored: true,\n";
      text[table] += spaces + spaces  + "classMethods: { \n";
      text[table] += spaces + spaces  + "},\n";
      text[table] += spaces + spaces  + "instanceMethods: {\n";
      text[table] += spaces + spaces  + "}\n";

      text[table] += "}\n";

//                   if (hasadditional) {
//                   _.each(options.additional, addAdditionalOption)
//                   }
//                   
      text[table] = text[table].trim()
      text[table] = text[table].substring(0, text[table].length - 1);
      text[table] += "\n" + spaces + "}";

      function addAdditionalOption(value, key) {
        text[table] += spaces + spaces + key + ": " + value + ",\n";
      }

      //resume normal output
      text[table] += ");\n};\n";
      _callback(null);
    }, function(){
      self.sequelize.close();

      self.write(text, callback);
    });
  }

}

AutoSequelize.prototype.write = function(attributes, callback) {
  var tables = _.keys(attributes);
  var self = this;

  async.series([findOrCreateDirectory], writeFile);

  function findOrCreateDirectory(_callback){
    fs.lstat(self.options.directory, function(err, stat){
      if (err || !stat.isDirectory()) {
        fs.mkdir(self.options.directory, _callback);
      } else {
        _callback(null);
      }
    })
  }

  function writeFile(err) {
    if (err) return callback(err);

    async.each(tables, createFile, callback)
  }

  function createFile(table, _callback){
    fs.writeFile(self.options.directory + '/' + table + '.js', attributes[table], _callback);
  }
}

module.exports = AutoSequelize