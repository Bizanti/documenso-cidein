import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Text } from 'react-email';
import { describe, expect, it } from 'vitest';

describe('scratch3', () => {
  it('renders Text', () => {
    const html = renderToStaticMarkup(createElement(Text, null, 'world'));
    console.log('TEXT HTML:', JSON.stringify(html));
    expect(html).toContain('world');
  });

  it('renders plain div', () => {
    const html = renderToStaticMarkup(createElement('div', null, 'hello'));
    expect(html).toContain('hello');
  });
});
