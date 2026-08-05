(() => {
  function clean(text) {
    return (text || '').replace(/\u00a0/g, ' ').trim();
  }

  function getPageTitle() {
    const titleEl = document.querySelector(
      '.notion-page-block .notion-title-holder, [placeholder="Untitled"], .notion-page-content h1, title'
    );
    if (titleEl && clean(titleEl.innerText)) {
      return clean(titleEl.innerText).replace(/\s*\|.*$/, '');
    }
    return 'Без названия';
  }

  const lines = [];
  const title = getPageTitle();
  lines.push('# ' + title);

  const blockElements = Array.from(document.querySelectorAll('[data-block-id]'));
  if (blockElements.length > 0) {
    blockElements.forEach((block) => {
      const h3 = block.querySelector('h3, .notion-sub_sub_header-block') ||
                 (block.matches('h3, .notion-sub_sub_header-block') ? block : null);
      if (h3) {
        const headingText = clean(h3.innerText);
        if (headingText) {
          lines.push('### ' + headingText);
        }
      } else {
        const text = clean(block.innerText);
        if (text) {
          lines.push(text);
        }
      }
    });
  } else {
    const bodyText = clean(document.body ? document.body.innerText : '');
    if (bodyText) {
      lines.push(bodyText);
    }
  }

  return lines.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
})();
