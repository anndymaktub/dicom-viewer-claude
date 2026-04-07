'use strict';

const { app, BrowserWindow, Menu, dialog } = require('electron');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0d1117',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile('index.html');

  const menuTemplate = [
    {
      label: '檔案',
      submenu: [
        {
          label: '載入',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
              title: '選擇 DICOM 檔案',
              filters: [
                { name: 'DICOM Files', extensions: ['dcm', 'dicom', 'DCM', 'img'] },
                { name: 'All Files', extensions: ['*'] },
              ],
              properties: ['openFile'],
            });
            if (!canceled && filePaths.length > 0) {
              mainWindow.webContents.send('load-dicom-path', filePaths[0]);
            }
          },
        },
        { type: 'separator' },
        {
          label: '開發者工具 (除錯)',
          accelerator: 'F12',
          click: () => mainWindow.webContents.toggleDevTools(),
        },
        { type: 'separator' },
        {
          label: '離開',
          accelerator: 'Alt+F4',
          role: 'quit',
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
