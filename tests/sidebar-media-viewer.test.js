import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const bundle of ['client.js', 'client-registry.js']) {
  test(`${bundle}: native file links claim media and render session-aware viewers`, () => {
    const source = readFileSync(new URL(`../sidebar-adapter/lib/${bundle}`, import.meta.url), 'utf8');
    const start = source.indexOf('function builtinViewers() {');
    const end = source.indexOf('//#endregion', start);
    const jsx = (type, props) => ({ type, props });
    const context = {
      react_jsx_runtime: { jsx, jsxs: jsx },
      sidebar_module_css_default: {},
      downloadUrl: (scope, path) => `/sidebar/file?sessionId=${scope.sessionId}&path=${encodeURIComponent(path)}&download=1`,
      PdfView: function PdfView() {}, LazyTextEditor: () => {},
      t: key => key,
    };
    const descriptors = vm.runInNewContext(`${source.slice(start, end)}; builtinViewers()`, context);
    const props = { scope: { sessionId: 'remote' }, path: '/srv/项目/chart.png', title: 'chart', mediaUrl: '/sidebar/file?sessionId=remote&path=%2Fsrv%2Fchart.png' };
    const image = descriptors.find(viewer => viewer.id === 'image');
    assert.equal(image.fetchStrategy, 'mediaUrl');
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']) assert.ok(image.exts.includes(ext));
    const tree = image.component(props);
    assert.equal(tree.props.children[1].props.children.type, 'img');
    assert.equal(tree.props.children[1].props.children.props.src, props.mediaUrl);
    assert.match(tree.props.children[0].props.children.props.href, /sessionId=remote/);
    const pdf = descriptors.find(viewer => viewer.id === 'pdf');
    assert.equal(pdf.fetchStrategy, 'none');
    assert.equal(pdf.component({ ...props, path: '/srv/report.pdf' }).props.path, '/srv/report.pdf');
    assert.equal(pdf.component(props).type, context.PdfView);
    const ownedStart = source.indexOf('const HOST_OWNED_EXTS =');
    const ownedEnd = source.indexOf('//#endregion', ownedStart);
    const hostOwned = vm.runInNewContext(`${source.slice(ownedStart, ownedEnd)}; hostOwnedPath`);
    for (const path of ['a.png', '/srv/a.PDF', '/srv/a.svg', '/srv/a.avif']) assert.equal(hostOwned(path), false);
    for (const path of ['a.docx', 'a.xlsx', 'a.pptx']) assert.equal(hostOwned(path), true);
    const addressStart = source.indexOf('function resolveAddressPath(base, path) {');
    const addressEnd = source.indexOf('//#endregion', addressStart);
    const resolveAddress = vm.runInNewContext(`${source.slice(addressStart, addressEnd)}; resolveAddressPath`, { resolveSidebarPath: (_base, path) => path });
    assert.equal(resolveAddress('C:\\local\\anchor', '/srv/report.pdf'), '/srv/report.pdf');
  });
}
