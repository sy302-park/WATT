var async = require('async');
var config = require('config');
var debug = require('debug')('routes:project');
var fs = require('fs');
var fse = require('fs-extra');
var path = require('path');
var xml2js = require('xml2js');

var util = require('../libs/util');
var Project = require('../models/project');

module.exports = function(express) {
  var router = express.Router();

  router.get('/', util.isLoggedIn, function(req, res) {
    var user = req.user;

    Project.find({ 'user' : user._id }, function(err, projects) {
      if (err) {
        debug(err);
        return res.status(400).send(err);
      }

      if (process.env.NODE_ENV === 'test') {
        return res.send(projects);
      }

      res.render('project', {
        user: user,
        projects : projects,
        isPWE: config.PWE
      });
    });
  });

  router.put('/', util.isLoggedIn, function(req, res) {
    var user = req.user;
    var data = req.body;

    // Check the type of project data whether it is correct
    if (typeof data !== 'object' ||
        typeof data.name !== 'string' ||
        typeof data.description !== 'string' ||
        typeof data.format !== 'string' ||
        typeof data.profile !== 'string' ||
        typeof data.version !== 'string' ||
        typeof data.type !== 'string' ||
        typeof data.templateName !== 'string') {
      return res.status(400).send('Project data is wrong');
    }

    var projectId;
    var projectPath;
    var supportPath;

    async.waterfall([
      function(callback) {
        // Finder the projects using user id
        Project.find({'user': user._id}, function(error, projects) {
          if (error) {
            return callback(error);
          }

          // Check duplicated project name
          for (var i=0; i<projects.length; i++) {
            if (projects[i].name === data.name) {
              return callback('Duplicated project name.');
            }
          }

          callback(null);
        });
      },
      function(callback) {
        // Create new project
        var newProject = new Project();

        newProject.name = data.name;
        newProject.user = user._id;
        newProject.created = new Date();
        newProject.profile = data.profile;
        newProject.version = data.version;
        newProject.type = data.type;
        newProject.description = data.description;

        newProject.save(function(error, project) {
          if (error) {
            return callback(error);
          }

          callback(null, project);
        });
      },
      function(project, callback) {
        // Create the project folder
        projectId = project._id.toString();
        projectPath = path.join(process.cwd(), 'projects', projectId);

        fse.ensureDir(projectPath, function(error) {
          if (error) {
            return callback(error);
          }

          callback(null);
        });
      },
      function(callback) {
        // Skip copy template when empty check box is enabled
        if (data.templateName === '') {
          return callback(null);
        }

        // Copy the template to project folder
        var templatePath = path.join(process.cwd(), data.format, data.type, data.templateName);
        fse.ensureDir(templatePath, function(error) {
          if (error) {
            return callback(error);
          }

          fse.copy(templatePath, projectPath, function(err) {
            if (err) {
              return callback(err);
            }

            callback(null);
          });
        });
      },
      function(callback) {
        // Check project type because we create config.xml for 'web' project
        if (data.type !== 'web') {
          return callback(null);
        }

        // Create config xml        
        fs.readFile(path.join(process.cwd(), 'models', 'config.xml'), function(error, config) {
          if (error) {
            return callback(error);
          }

          var parser = new xml2js.Parser();
          parser.parseString(config, function(parseError, result) {
            if (parseError) {
              return callback(parseError);
            }

            var widget = result.widget;
            var projectName = data.name;
            var packageId = projectId.substring(0, 10);

            widget.name[0] = projectName;
            widget['tizen:application'][0]['$'].package = packageId;
            widget['tizen:application'][0]['$'].id = [packageId, projectName].join('.');
            widget['tizen:application'][0]['$']['required_version'] = data.version;
            widget['$'].id = 'http://yourdomain/' + projectName;
            widget['tizen:profile'][0]['$'].name = data.profile;

            var builderOption = {
              xmldec: {
                'version': '1.0',
                'encoding': 'UTF-8'
              }
            };

            var builder = new xml2js.Builder(builderOption);
            var xml = builder.buildObject(result);
            fs.writeFile(path.join(projectPath, 'config.xml'), xml, callback);
          });
        });
      },
      function(callback) {
        // Create project support folder
        supportPath = path.join(process.cwd(), 'projects', 'support', projectId);
        fse.ensureDir(supportPath, function(error) {
          if (error) {
            return callback(error);
          }

          var state = require(path.join(process.cwd(), 'models', 'state.json'));
          state.projectId = projectId;
          state.projectName = data.name;
          state.projectType = data.type;
          state.projectProfile = data.profile;
          state.projectVersion = data.version;
          if (process.env.NODE_ENV === 'pwe') {
            state.projectUser = user.pwe.id;
          }
          fs.writeFile(path.join(supportPath, 'state.json'), JSON.stringify(state), callback);
        });
      }
    ], function(error) {
      if (error) {
        // Remove project database if adding project failed
        if (projectId) {
          Project.remove({'_id': projectId }, function(removeError) {
            if (removeError) {
              console.error(removeError);
            }
          });
        }

        // Remove project folder if adding project failed
        if (projectPath) {
          fse.remove(projectPath, function(removeError) {
            if (removeError) {
              console.error(removeError);
            }
          });
        }

        // Remove project support folder if adding project failed
        if (supportPath) {
          fse.remove(supportPath, function(removeError) {
            if (removeError) {
              console.error(removeError);
            }
          });
        }

        return res.status(400).send(error);
      }

      res.send(projectId);
    });
  });

  router.get('/:projectId', util.isLoggedIn, function(req, res) {
    var projectId = req.params.projectId;
    var user = req.user;

    Project.find({ '_id' : projectId }, function(err, projects) {
      if (err) {
        debug(err);
        return res.status(400).send(err);
      }

      if (projects.length === 0) {
        return res.status(400).send('Not found project');
      }

      var project = projects[0];
      if (project.user.toString() !== user._id.toString()) {
        return res.status(400).send('Not user project');
      }

      return res.send(project);
    });
  });

  router.post('/:projectId', util.isLoggedIn, function(req, res) {
    var data = req.body;
    var projectId = req.params.projectId;
    var user = req.user;

    // Check the type of project data whether it is correct
    if (typeof data !== 'object' ||
        typeof data.name !== 'string' ||
        typeof data.description !== 'string' ||
        typeof data.profile !== 'string' ||
        typeof data.version !== 'string') {
      return res.status(400).send('Project data is wrong');
    }

    async.waterfall([
      function(callback) {
        Project.find({ '_id' : projectId }, function(error, projects) {
          if (error) {
            debug(error);
            return callback(error);
          }

          if (projects.length === 0) {
            return callback('Not found project');
          }

          var project = projects[0];
          if (project.user.toString() !== user._id.toString()) {
            return callback('Not user project');
          }

          // If input name is diffrent with existing name,
          // we try to check project name whether it is duplicated or not
          if (project.name !== data.name) {
            Project.find({'user': user._id}, function(error, projects) {
              if (error) {
                return callback(error);
              }

              // Check duplicated project name
              for (var i=0; i<projects.length; i++) {
                if (projects[i].name === data.name) {
                  return callback('Duplicated project name.');
                }
              }

              callback(null, project);
            });
          } else {
            callback(null, project);
          }
        });
      },
      function(project, callback) {
        // Save modified project information
        project.name = data.name;
        project.description = data.description;
        if (project.type === 'web') {
          project.profile = data.profile;
          project.version = data.version;
        }

        project.save(function(saveError, result) {
          if (saveError) {
            debug(saveError);
            return callback(saveError);
          }

          callback(null, result);
        });
      }, function(project, callback) {
        var supportPath = path.join(process.cwd(), 'projects', 'support', projectId);
        var state = require(path.join(supportPath, 'state.json'));
        state.projectName = data.name;
        if (state.projectType === 'web') {
          state.projectProfile = data.profile;
          state.projectVersion = data.version;
        }
        fs.writeFile(path.join(supportPath, 'state.json'), JSON.stringify(state), function(error) {
          if (error) {
            return callback(error);
          }

          callback(null, project);
        });
      }
    ], function(error, project) {
      if (error) {
        debug(error);
        return res.status(400).send(error);
      }

      res.send(project);
    });
  });

  router.delete('/:projectId', util.isLoggedIn, function(req, res) {
    var projectId = req.params.projectId;
    var user = req.user;

    async.waterfall([
      function(callback) {
        // Remove the project using projectId
        Project.remove({ '_id': projectId }, function(error) {
          if (error) {
            return callback(error);
          }

          callback(null);
        });
      },
      function(callback) {
        // Remove the project folder
        var projectPath = path.join(process.cwd(), 'projects', projectId);
        fse.ensureDir(projectPath, function(error) {
          if (error) {
            return callback(error);
          }

          fse.remove(projectPath, function(err) {
            if (err) {
              return callback(err);
            }

            callback(null);
          });
        });
      },
      function(callback) {
        // Remove the project support folder
        var supportPath = path.join(process.cwd(), 'projects', 'support', projectId);
        fse.ensureDir(supportPath, function(error) {
          if (error) {
            return callback(error);
          }

          fse.remove(supportPath, function(err) {
            if (err) {
              return callback(err);
            }

            callback(null);
          });
        });
      }
    ], function(error) {
      if (error) {
        return res.status(400).send(error);
      }

      res.send();
    });
  });

  return router;
};
