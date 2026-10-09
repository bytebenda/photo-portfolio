// Site-wide settings.
export default {
  // Shown in the browser tab and the top left corner.
  name: 'DIETER.VISUALS',
  // The photographer, shown in the footer and the page descriptions.
  author: 'Dieter Van Stijvendael',
  description: 'Photography by Dieter Van Stijvendael',
  instagramUrl: 'https://www.instagram.com/dieter.vs/',
  // Google Drive folder that "npm run import" copies the photos from, subfolders included.
  // The DRIVE_FOLDER environment variable overrides it.
  driveFolder: '1bI3UMU72kDGNHp5NbWXcvVHMj0Eokb5D',
  // Drive folders that are never imported, at any depth, with everything in them.
  // Names match without regard to case.
  driveSkipFolders: ['Private'],
  // Drive folder whose subfolders, named "<Country> - <Place>", make the Location filter.
  locationRoot: 'Favorites',
};
