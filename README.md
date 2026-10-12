# Packet Scan Tasks

A web app for packing teams with two roles:

- **Manager**: uploads an Excel or PDF of tracking IDs to create a task, names it (the name can be changed later), and can make it open to any packer or to just one. Managers see every task's progress live, and can reopen, delete and export tasks.
- **Packer**: accepts a task and scans its packets with a barcode scanner, the phone camera or a photo. They get the scan result, sounds, undo, mark-by-hand, the Not-in-list check, copy and an Excel report, then finish the task.

The app is static files on GitHub Pages. Tasks and scans are stored in Firebase (Firestore) and sign-in uses Firebase Auth, so passwords are never in this repository.

## Team logins

| Role | Email |
|---|---|
| Manager | manager1@packscan.local |
| Manager | manager2@packscan.local |
| Manager | manager3@packscan.local |
| Packer | packer1@packscan.local |
| Packer | packer2@packscan.local |
| Packer | packer3@packscan.local |
| Packer | packer4@packscan.local |
| Packer | packer5@packscan.local |

Passwords are set in Firebase (step 4) and shared with the team privately.

## One-time Firebase setup

1. Go to <https://console.firebase.google.com>, click **Create a project**, and give it any name. Google Analytics is not needed.
2. **Add a Web app**: in Project overview, click the `</>` icon and register an app (Firebase Hosting is not needed). Copy the `firebaseConfig` values into `firebase-config.js` in this repository.
3. **Turn on sign-in**: Build > Authentication > Get started > Sign-in method > **Email/Password** > Enable > Save.
4. **Add the 8 users**: Authentication > Users > **Add user**, once for each email in the table above, each with its own password.
5. **Create the database**: Build > Firestore Database > **Create database**. Pick a location near you and start in **production mode**.
6. **Paste the rules**: Firestore Database > **Rules**. Replace everything with the contents of `firestore.rules` from this repository, then click **Publish**.
7. Commit the updated `firebase-config.js`. The site updates on GitHub Pages within a minute or two.

## Changing who is a manager or packer

The email lists are in two places, and both must match:

- `app.js`: the `MANAGERS` and `PACKERS` lists at the top of the file
- `firestore.rules`: the `isManager()` and `isPacker()` functions (publish the rules again after editing)

Then add or remove the user in Firebase Authentication.
