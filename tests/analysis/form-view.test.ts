import { describe, expect, it } from 'vitest';
import { parseFormFields } from '../../src/ui/components/CodeView';

describe('form body display', () => {
  it('decodes URL-encoded fields in order, including JSON values', () => {
    const text =
      'FirstName=Alaa&RedirectUrl=http%3A%2F%2Flocalhost%3A3000%2Fen%2Fsuccess&RecipientPhone=%2B201555555555' +
      '&RecipientEmail=alaa.ahmed.ce%40gmail.com&Items=%5B%7B%22productVariantId%22%3A9%2C%22quantity%22%3A1%7D%5D&Empty=';
    expect(parseFormFields(text)).toEqual([
      { name: 'FirstName', value: 'Alaa' },
      { name: 'RedirectUrl', value: 'http://localhost:3000/en/success' },
      { name: 'RecipientPhone', value: '+201555555555' },
      { name: 'RecipientEmail', value: 'alaa.ahmed.ce@gmail.com' },
      { name: 'Items', value: '[{"productVariantId":9,"quantity":1}]' },
      { name: 'Empty', value: '' },
    ]);
  });

  it('falls back for text that is not URL-encoded', () => {
    expect(parseFormFields('just some text')).toBeNull();
    expect(parseFormFields('{"a":1}')).toBeNull();
  });
});
