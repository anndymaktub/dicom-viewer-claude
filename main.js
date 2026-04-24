'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { version } = require('./package.json');
let buildDate = '';
try { buildDate = require('./build-info.json').buildDate; } catch (_) {}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0d1117',
    title: `DICOM Viewer v${version}`,
    icon: path.join(__dirname, 'icon', 'icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      nodeIntegrationInWorker: true,
      contextIsolation: false,
      // TODO: 為完整安全性，應使用 bundler (esbuild/webpack) 打包 renderer.js，
      // 然後設定 nodeIntegration: false, contextIsolation: true + preload script。
      // 目前 renderer.js 直接 require() npm 模組，無法在隔離環境下運作。
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
    {
      label: 'Function',
      submenu: [
        {
          label: 'Export Raw Histogram CSV',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => mainWindow.webContents.send('export-raw-histogram-csv'),
        },
      ],
    },
    {
      label: '說明',
      submenu: [
        {
          label: `關於 DICOM Viewer`,
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '關於 DICOM Viewer',
              message: `DICOM Viewer`,
              detail: `版本：v${version}\n建置：${buildDate || '(unknown)'}\n作者：Anndy\n授權：GPL v2\n\nhttps://github.com/anndymaktub/dicom-viewer-claude`,
              buttons: ['確定'],
            });
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
}

ipcMain.handle('save-raw-histogram-csv', async (_event, { csv, defaultPath }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Raw Histogram CSV',
    defaultPath: defaultPath || 'raw_histogram.csv',
    filters: [
      { name: 'CSV Files', extensions: ['csv'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (canceled || !filePath) return { canceled: true };
  fs.writeFileSync(filePath, csv, 'utf8');
  return { canceled: false, filePath };
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
