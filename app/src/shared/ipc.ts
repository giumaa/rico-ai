// IPC channel names shared by main and preload (pure constants — safe to bundle into the sandboxed preload).
// The renderer never uses these directly: it talks to `window.rico` (see api.ts).

export const IPC = {
  // request/response (ipcRenderer.invoke <-> ipcMain.handle)
  systemGetInfo: 'rico:system:getInfo',
  systemGetDataPath: 'rico:system:getDataPath',
  systemOpenDataFolder: 'rico:system:openDataFolder',
  windowSetTitleBarTheme: 'rico:window:setTitleBarTheme',

  modelsList: 'rico:models:list',
  modelsDownload: 'rico:models:download',
  modelsCancelDownload: 'rico:models:cancelDownload',
  modelsImportFile: 'rico:models:importFile',
  modelsRemove: 'rico:models:remove',
  modelsSetActive: 'rico:models:setActive',
  modelsGetLoadState: 'rico:models:getLoadState',

  chatGenerate: 'rico:chat:generate',
  chatStop: 'rico:chat:stop',

  chatsList: 'rico:chats:list',
  chatsGet: 'rico:chats:get',
  chatsSave: 'rico:chats:save',
  chatsDelete: 'rico:chats:delete',
  chatsDeleteAll: 'rico:chats:deleteAll',

  settingsGet: 'rico:settings:get',
  settingsSet: 'rico:settings:set',

  // main -> renderer push events (webContents.send <-> ipcRenderer.on)
  evModelsProgress: 'rico:ev:models:progress',
  evModelsLoadState: 'rico:ev:models:loadState',
  evChatToken: 'rico:ev:chat:token',
  evChatDone: 'rico:ev:chat:done',
  evChatError: 'rico:ev:chat:error'
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
