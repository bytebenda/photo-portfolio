// Site-wide settings.
export default {
  name: 'Dieter',
  description: 'Photography by Dieter',
  instagramUrl: 'https://www.instagram.com/dieter.vs/',
  // Google Drive folder that "npm run import" copies the photos from, subfolders included.
  // The DRIVE_FOLDER environment variable overrides it.
  driveFolder: '1bI3UMU72kDGNHp5NbWXcvVHMj0Eokb5D',
  // Drive folders that are never imported, at any depth, with everything in them.
  // Names match without regard to case.
  driveSkipFolders: ['Private'],
};
