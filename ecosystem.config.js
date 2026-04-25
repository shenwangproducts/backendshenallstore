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
      instances: 'max', // 🌟 รีดพลัง CPU ทั้ง 8 Core ออกมาทำงานพร้อมกัน
      exec_mode: 'cluster', // 🌟 ใช้โหมด Cluster เพื่อกระจายโหลด
      watch: false, // ใน Production สเปกสูง แนะนำให้ปิด watch เพื่อประหยัด I/O
      max_memory_restart: '4G', // 🌟 ให้แต่ละ Worker ใช้ RAM ได้เต็มที่ (คุณมีถึง 32GB)
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};