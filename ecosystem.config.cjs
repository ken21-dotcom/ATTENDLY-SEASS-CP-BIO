module.exports = {
  apps: [
    {
      name: 'prototype-5173',
      cwd: './',
      script: 'node_modules/http-server/bin/http-server',
      args: '-p 5173 -c-1',
      interpreter: 'C:/Program Files/nodejs/node.exe',
      env: {
        NODE_ENV: 'development'
      }
    }
  ]
};
