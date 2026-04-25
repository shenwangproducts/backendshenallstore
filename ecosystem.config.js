module.exports = {
  apps: [
    {
      name: 'shenall-main-backend',
      script: 'server.js',
      watch: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    },
    {
      name: 'shenall-apk-worker',
      script: 'apk_scan_service.js',
      watch: true,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};