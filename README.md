+-------------------+       +-------------------+       +-----------------------+
|   Frontend (Web)  |       |   Main Backend    |       |  APK Scan Microservice  |
| (console.js)      |       |   (server.js)     |       | (New Node.js Service) |
+-------------------+       +-------------------+       +-----------------------+
        |                           |                               |
        | 1. Upload APK to R2       |                               |
        |-------------------------->|                               |
        |                           |                               |
        | 2. Send Scan Request      |                               |
        | (APK URL, App ID)         |                               |
        |-------------------------->|                               |
        |                           |                               |
        | 3. Publish Message        |                               |
        | (to Message Queue)        |                               |
        |                           |------------------------------->|
        |                           |                               |
        |                           |                               | 4. Consume Message
        |                           |                               | (Download APK from R2)
        |                           |                               |<------------------+
        |                           |                               |                   |
        |                           |                               | 5. Perform Scan   |
        |                           |                               | (CPU-intensive)   |
        |                           |                               |                   |
        |                           |                               | 6. Update Firestore |
        |                           |                               | (with scan results) |
        |                           |<------------------------------|-------------------+
        |                           |                               |
        | 7. Poll for Status        |                               |
        |<--------------------------|                               |
        |                           |                               |
        | 8. Display Results        |                               |
        |<--------------------------|                               |
