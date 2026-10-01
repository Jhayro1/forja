import { describe, expect, it } from 'vitest';
import { jsonBody } from '../../src/runtime/launch-service.js';

describe('salida estructurada en texto', () => {
  it('saca el objeto JSON aunque venga entre ``` o con una frase', () => {
    expect(JSON.parse(jsonBody('{"a":1}'))).toEqual({ a: 1 });
    expect(JSON.parse(jsonBody('```json\n{"a":{"b":[1]}}\n```'))).toEqual({ a: { b: [1] } });
    expect(JSON.parse(jsonBody('Aquí está la especificación:\n{"a":1}\nListo.'))).toEqual({ a: 1 });
    expect(jsonBody('sin json')).toBe('sin json');
  });
});
