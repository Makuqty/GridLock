# GridLock

A real-time multiplayer GridLock game built with Node.js, Express, Socket.IO, and Firebase.

## Features
- User registration and authentication
- Real-time multiplayer gameplay
- Challenge system
- Leaderboard
- In-game chat
- Rematch functionality
- Firebase Firestore database

## Setup

### 1. Firebase Configuration

1. Create a Firebase project at [Firebase Console](https://console.firebase.google.com/)
2. Enable Firestore Database
3. Create a service account:
   - Go to Project Settings > Service Accounts
   - Click "Generate New Private Key"
   - Download the JSON file
4. Copy values from the JSON to `.env` file

### 2. Environment Variables

Create a `.env` file with:

```env
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_PRIVATE_KEY_ID=your-private-key-id
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_KEY\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=your-email@project.iam.gserviceaccount.com
FIREBASE_CLIENT_ID=your-client-id
FIREBASE_CLIENT_X509_CERT_URL=your-cert-url
JWT_SECRET=your-random-secret-key
```

### 3. Local Development

```bash
npm install
npm start
```

The game will be available at `http://localhost:3000`

## Deployment on Render

1. Push your code to GitHub
2. Connect your GitHub repository to Render
3. Add environment variables in Render dashboard
4. Render will automatically detect the `render.yaml` configuration
5. Your app will be deployed and accessible via the provided URL