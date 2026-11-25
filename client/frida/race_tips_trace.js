'use strict';

const MOD = 'libil2cpp.so';

function log(msg) {
  console.log('[tips ' + new Date().toISOString().substr(11, 12) + '] ' + msg);
}

const HOOKS = [
  { name: 'RaceTop.ShowOnOpenAsync.MoveNext', rva: 0x4374588, kind: 'sm' },
  { name: 'RaceTop.CheckShowSubItemsAsync.MoveNext', rva: 0x436FF0C, kind: 'sm' },
  { name: 'RaceTop.LoadImagesAsync.MoveNext', rva: 0x4371148, kind: 'sm' },
  { name: 'RaceTop.ShowDokanAndTutorialAsync.MoveNext', rva: 0x4374068, kind: 'sm' },
  { name: 'TipsDialogPresenter.ShowTipsAsync', rva: 0x45CDC58, kind: 'call' },
  { name: 'TipsDialogPresenter.OpenAndWaitCloseAsync', rva: 0x45CDBB0, kind: 'call' },
  { name: 'TipsDialogPresenter.OpenTipsTutorialAsync', rva: 0x45CDD90, kind: 'call' },
  { name: 'TipsDialogPresenter.SetData', rva: 0x45CDE30, kind: 'call', readAssetId: true },
  { name: 'TipsDialogView.OpenAsync', rva: 0x45CF50C, kind: 'call' },
  { name: 'TipsDialogView.OpenAsync.MoveNext', rva: 0x45CF5B8, kind: 'sm' },
  { name: 'TextureResourceView.WaitForLoadEndAsync', rva: 0x501EA48, kind: 'call' },
  { name: 'TextureResourceView.WaitForLoadEndAsync.MoveNext', rva: 0x501EB20, kind: 'sm' },
  { name: 'TextureResourceView.WaitForLoadEndAsync.pred', rva: 0x501EAE4, kind: 'pred' },
];

function readIl2cppString(p) {
  if (p.isNull()) {
    return '<null>';
  }
  try {
    const len = p.add(0x10).readS32();
    if (len < 0 || len > 4096) {
      return '<bad len ' + len + '>';
    }
    return p.add(0x14).readUtf16String(len);
  } catch (e) {
    return '<read fail: ' + e.message + '>';
  }
}

function installHooks(base) {
  let installed = 0;
  for (const hook of HOOKS) {
    try {
      if (hook.kind === 'sm') {
        Interceptor.attach(base.add(hook.rva), {
          onEnter: function (args) {
            this.p = args[0];
            this.s = args[0].readS32();
            log(hook.name + ' enter state=' + this.s);
          },
          onLeave: function () {
            log(hook.name + ' leave state=' + this.p.readS32());
          }
        });
      } else if (hook.kind === 'call') {
        Interceptor.attach(base.add(hook.rva), {
          onEnter: function (args) {
            log(hook.name + ' called');
            if (hook.readAssetId) {
              log(hook.name + ' assetId=' + readIl2cppString(args[1]));
            }
          }
        });
      } else if (hook.kind === 'pred') {
        const state = { count: 0, last: null };
        Interceptor.attach(base.add(hook.rva), {
          onLeave: function (retval) {
            const v = retval.toInt32() & 1;
            state.count++;
            const changed = state.last === null || v !== state.last;
            state.last = v;
            if (state.count <= 5 || state.count % 300 === 0 || changed) {
              log(hook.name + ' #' + state.count + ' -> ' + v);
            }
          }
        });
      } else {
        log('hook failed: ' + hook.name + ' unknown kind=' + hook.kind);
      }
      installed++;
    } catch (e) {
      log('hook failed: ' + hook.name + ' ' + e.message);
    }
  }
  log('hooks installed: ' + installed);
}

function waitForModule() {
  const mod = Process.findModuleByName(MOD);
  if (mod !== null) {
    installHooks(mod.base);
  } else {
    setTimeout(waitForModule, 200);
  }
}

waitForModule();
