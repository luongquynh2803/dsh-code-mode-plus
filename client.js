window.__ModuleLoader__.load({
  id: '@local/dsh-code-mode-plus',
  factory(require) {
    const { createElement: h, useSyncExternalStore } = require('react');
    const namespace = 'local-code-mode-plus';
    const dictionaries = {
      en: { title: 'Code batch', preparing: 'Preparing', running: 'Running', finished: 'Finished', failed: 'Failed', source: 'View code', result: 'Result' },
      zh: { title: '\u4ee3\u7801\u6279\u5904\u7406', preparing: '\u51c6\u5907\u4e2d', running: '\u8fd0\u884c\u4e2d', finished: '\u5df2\u5b8c\u6210', failed: '\u5931\u8d25', source: '\u67e5\u770b\u4ee3\u7801', result: '\u7ed3\u679c' },
      vi: { title: 'Code batch', preparing: '\u0110ang chu\u1ea9n b\u1ecb', running: '\u0110ang ch\u1ea1y', finished: '\u0110\u00e3 xong', failed: 'Th\u1ea5t b\u1ea1i', source: 'Xem m\u00e3', result: 'K\u1ebft qu\u1ea3' },
    };
    const codeStyle = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '22rem', overflow: 'auto', margin: '0.4rem 0' };

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        for (const [locale, dictionary] of Object.entries(dictionaries)) {
          ctx.effect(() => ctx.locale.register(namespace, locale, dictionary), `Code Mode Plus locale: ${locale}`);
        }
        const t = ctx.locale.bind(namespace);
        const subscribe = (callback) => ctx.locale.subscribe(callback);
        const snapshot = () => ctx.locale.getSnapshot();

        function CodeBatch({ phase, block }) {
          useSyncExternalStore(subscribe, snapshot);
          const description = block.args?.text?.('description');
          const code = phase === 'preparing' ? '' : block.args?.text?.('code');
          const result = phase === 'result' ? block.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n') : '';
          const status = phase === 'result' ? (block.isError ? 'failed' : 'finished') : phase === 'start' ? 'running' : 'preparing';
          return h('div', { style: { minWidth: 0, maxWidth: '100%', padding: '0.25rem 0' } },
            h('div', { style: { overflowWrap: 'anywhere' } },
              h('strong', null, t('title')), description ? `: ${description}` : '', ' \u00b7 ', h('span', { role: 'status' }, t(status))),
            code ? h('details', null, h('summary', null, t('source')), h('pre', { style: codeStyle }, h('code', null, code))) : null,
            result ? h('details', { open: block.isError || undefined }, h('summary', null, t('result')), h('pre', { style: codeStyle }, result)) : null,
          );
        }

        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'code_batch' }, CodeBatch));
      },
    };
  },
});
