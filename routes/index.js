/*
 * routes/index.js
 */

var BASE_PATH = "../lib/"

var _ = require('underscore')
  , async = require('async')
  , Step = require('step')
  , fs = require('fs')
  , path = require('path')

  , models = require(BASE_PATH + 'models')
  , common = require(BASE_PATH + 'common')
  , config = require(BASE_PATH + 'config')
  , jobs = require(BASE_PATH + 'jobs')
  , logging = require(BASE_PATH + 'logging')
  , User = require(BASE_PATH + 'models').User
  , Job = require(BASE_PATH + 'models').Job
  , pjson = require('../package.json')
  , async = require('async')

var TEST_ONLY = "TEST_ONLY";
var TEST_AND_DEPLOY = "TEST_AND_DEPLOY";

/*
 * GET home page.
 */

exports.index = function(req, res){
  if (req.session.return_to) {
    var return_to = req.session.return_to
    req.session.return_to=null
    return res.redirect(return_to)
  }
  var code = ""
  if (req.param('code') !== undefined) {
    code = req.param('code')
    return res.render('register.html', {invite_code:code})
  }
  jobs.latestJobs(req.user, true, function (err, jobs) {
    res.render('index.html', {jobs: jobs})
  })
};


/* TODO: This is currently disabled. Do we need a kickoff at all?
 *
 * GET /kickoff  - start configuration wizard for a job
exports.kickoff = function(req, res, github) {
  var gh = github || gh;
  // Assert cached github metadata
  if (req.user.github_metadata === undefined
    || req.user.github_metadata[req.user.github.id] === undefined) {
    res.statusCode = 400;
    res.end("please call /api/github/metadata before this");
  } else {
    // Find the metadata for the repo we are kicking off on
    var kickoff_repo_metadata = req.user.get_repo_metadata(req.params.githubId);
    var trepo = whitelist_repo_metadata(kickoff_repo_metadata);
    // Check whether someone else has already configured this repository
    User.findOne({'github_config.url':trepo.url.toLowerCase()}, function(err, user) {
      if (!user) {
        res.render('kickoff.html', {repo: JSON.stringify(trepo)})
      } else {
        res.render('kickoff-conflict.html', {repo: JSON.stringify(trepo)});
      }
    });

  }
};
 */

/*
 * GET /account - account settings page
 */
exports.account = function(req, res){
  res.render('account.html', {
    user: req.user.toJSON()
  });
};

// GET /:org/:repo/config/:branch/:pluginname
// Output: the config
exports.getPluginConfig = function (req, res) {
  res.send(req.pluginConfig())
}

// POST /:org/:repo/config/:branch/:pluginname
// Set the configuration for a plugin on a branch. Output: the new config.
exports.setPluginConfig = function (req, res) {
  req.pluginConfig(req.body, function (err, config) {
    if (err) return res.send(500, {error: 'Failed to save plugin config'})
    res.send(config)
  })
}

exports.setPluginOrder = function (req, res) {
  var branch = req.project.branch(req.params.branch)
  if (!branch) {
    return res.send(400, 'Invalid branch')
  }
  var plugins = req.body
    , old = branch.plugins || []
    , map = {}
    , i
  for (i=0; i<old.length; i++) {
    map[old[i].id] = old[i]
  }
  for (i=0; i<plugins.length; i++) {
    if (map[plugins[i].id]) {
      plugins[i].config = map[plugins[i].id].config
    } else {
      plugins[i].config = {}
    }
  }
  branch.plugins = plugins
  req.project.markModified('branches')
  req.project.save(function (err) {
    if (err) return res.send(500, 'Failed to save plugin config')
    res.send({success: true})
  })
}

/*
 * GET /:org/:repo/config - project config page
 */
exports.config = function(req, res) {
  User.collaborators(req.project.name, 0, function (err, users) {
    var data = {
      collaborators: {},
      project: req.project.toJSON()
    }
    for (var i=0; i<users.length; i++) {
      var p = _.find(users[i].projects, function(p) {
        return p.name === req.project.name
      })
      data.collaborators[users[i].email] = p.access_level
    }
    data.provider = common.pluginConfigs.provider[req.project.provider.id]
    data.runners = common.pluginConfigs.runner
    data.plugins = common.pluginConfigs.job

    var provider = common.extensions.provider[req.project.provider.id]
    if (typeof provider.getBranches === 'function') {
      provider.getBranches(req.user.account(req.project.provider),
        req.project.provider.config, req.project, function(err, branches) {
        if (err) {
          console.error("could not fetch branches for repo %s: %s", req.project.name, err)
          return res.render('project_config.html', data)
        }
        data.branches = branches
        res.render('project_config.html', data)
      })
    } else {
      res.render('project_config.html', data)
    }
  })
}

/*
 * /status endpoint
 * Executes a simple database query to verify that system is operational.
 * Assumes there is at least 1 user in the system.
 * Returns 200 on success.
 *
 * This is for use by Pingdom and similar monitoring systems.
 */
exports.status = function(req, res) {

  function error(message) {
    res.statusCode = 500;
    var resp = {
      status: "error",
      version: "StriderCD (http://stridercd.com) " + pjson.version,
      results: [],
      errors: [{message:message}]
    }
   return res.jsonp(resp)
  }

  function ok() {
    res.statusCode = 200;
    var resp = {
      status: "ok",
      version: "StriderCD (http://stridercd.com) " + pjson.version,
      results: [{message:"system operational"}],
      errors: []
    }
    return res.jsonp(resp)
  }

  User.findOne(function(err, user) {
    if (err) {
      return error("error retrieving user from DB: " + err);
    }
    if (!user) {
      return error("no users found in DB - mis-configured?")
    }
    return ok();
  });

};

// GET /projects
// 
// This is where the "add project" flow starts.
exports.projects = function(req, res) {
  var data = {}
  data.providers = []
  var f = []
  _.each(common.extensions.provider, function(v, k) {
    f.push(function(done) {
      var p = {}
      var accountConfig = _.find(req.user.accounts, function(a) {
        return a.provider === k
      }).config
      p.isSetup = v.isSetup(accountConfig)
      p.setupLink = v.setupLink
      p.name = k.toString()
      p.repos = []
      if (p.isSetup) {
        // get repos if we can
        v.listRepos(accountConfig, function(err, repos) {
          p.repos = repos
          data.providers.push(p)
          done()
        })
      } else {
        data.providers.push(p)
        done()
      }
    })
  })
  async.parallel(f, function(err, r) {
    return res.render('projects.html', data);
  })
}

