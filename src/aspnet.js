import { siteFetch } from './net.js';

export function parseHtml(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

/**
 * 파싱된 문서에서 폼의 현재 상태를 뽑는다.
 * DOMParser 문서에는 렌더링이 없으므로 속성(attribute)만 보고 판단한다.
 */
export function formState(doc, formEl) {
  const form = formEl || doc.querySelector('form');
  const data = {};
  if (!form) return data;

  for (const el of form.querySelectorAll('input, select, textarea')) {
    const name = el.getAttribute('name');
    if (!name) continue;
    const type = (el.getAttribute('type') || '').toLowerCase();

    if (type === 'submit' || type === 'image' || type === 'button' || type === 'file') continue;

    if (type === 'checkbox' || type === 'radio') {
      if (el.hasAttribute('checked')) data[name] = el.getAttribute('value') || 'on';
      continue;
    }

    if (el.tagName === 'SELECT') {
      const chosen = el.querySelector('option[selected]') || el.querySelector('option');
      data[name] = chosen ? (chosen.getAttribute('value') ?? chosen.textContent.trim()) : '';
      continue;
    }

    if (el.tagName === 'TEXTAREA') {
      data[name] = el.textContent ?? '';
      continue;
    }

    data[name] = el.getAttribute('value') ?? '';
  }

  return data;
}

/** 폼의 action 을 페이지 URL 기준 절대 주소로 바꾼다. */
export function formAction(doc, pageUrl, formEl) {
  const form = formEl || doc.querySelector('form');
  const action = form?.getAttribute('action');
  return new URL(action || pageUrl, pageUrl).href;
}

function buildBody(data, multipart) {
  if (!multipart) return { body: new URLSearchParams(data).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
  // multipart 는 경계 문자열을 직접 만든다(FormData 를 쓰면 executeScript 로 넘길 수 없다).
  const boundary = '----KRSMeetingRoom' + Math.random().toString(36).slice(2);
  let body = '';
  for (const [k, v] of Object.entries(data)) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v ?? ''}\r\n`;
  }
  body += `--${boundary}--\r\n`;
  return { body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}

/**
 * WebForms 포스트백을 보낸다.
 * @param {string} pageUrl  현재 페이지 주소
 * @param {Document} doc    현재 페이지 문서(ViewState 추출용)
 * @param {string} eventTarget __EVENTTARGET 값
 * @param {string} eventArgument __EVENTARGUMENT 값
 * @param {object} extra    덮어쓸 폼 필드
 */
export async function postback(pageUrl, doc, eventTarget = '', eventArgument = '', extra = {}) {
  const form = doc.querySelector('form');
  const data = formState(doc, form);
  data.__EVENTTARGET = eventTarget;
  data.__EVENTARGUMENT = eventArgument;
  Object.assign(data, extra);

  const multipart = /multipart\/form-data/i.test(form?.getAttribute('enctype') || '');
  const { body, headers } = buildBody(data, multipart);

  return siteFetch(formAction(doc, pageUrl, form), { method: 'POST', headers, body });
}
