import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmvco, extractBrebKey, decodeBrebString } from '../src/breb-qr.js';

// Strings EMVCo REALES decodificados de los 2 QR de Jhon Fredy (jun-2026).
// QR 2: llave alfanumérica @jhon437203 (tag 26.04).
const QR_LLAVE = '00020101021126330014CO.COM.RBM.LLA0411@jhon43720349250014CO.COM.RBM.RED0103RBM50290013CO.COM.RBM.CU01080000000051220013CO.COM.RBM.CA010105204000053031705802CO59010600106101062270710CC80144372080200110363180270016CO.COM.RBM.CANAL0103APP81250015CO.COM.RBM.CIVA01020282260014CO.COM.RBM.IVA01040.0083270015CO.COM.RBM.BASE01040.0084250015CO.COM.RBM.CINC01020285260014CO.COM.RBM.INC01040.0090430016CO.COM.RBM.TRXID0119000001Hnc8F81-4FW2h91460014CO.COM.RBM.SEC0124nW2B7BvQjf1jRoD475BbyCSs6304086E';

// QR 1: por cuenta/numérica (tag 26.05 = "353497", cuenta en 50.01), nombre comercio.
const QR_CUENTA = '00020101021126320014CO.COM.RBM.LLA0510002935349749250014CO.COM.RBM.RED0103RBM50310013CO.COM.RBM.CU011000293534975204000053031705502015802CO5922Supermercado pa mi gen600511001610511001622703030000703000080200110363180270016CO.COM.RBM.CANAL0103APP81250015CO.COM.RBM.CIVA01020182260014CO.COM.RBM.IVA01040.0083270015CO.COM.RBM.BASE01040.0084250015CO.COM.RBM.CINC01020185260014CO.COM.RBM.INC01040.0090430016CO.COM.RBM.TRXID0119000001I6ayJyyIOS_bD91460014CO.COM.RBM.SEC0124eFE7uHXU4FwbxK6MRAnHbf94630487B9';

describe('parseEmvco (TLV)', () => {
  test('parsea tags de primer nivel', () => {
    const tlv = parseEmvco(QR_LLAVE);
    assert.equal(tlv['00'], '01');           // payload format
    assert.equal(tlv['49'].children['01'], 'RBM'); // red Bre-B
  });

  test('tag 26 es un template con la info de la llave', () => {
    const tlv = parseEmvco(QR_LLAVE);
    assert.ok(tlv['26'].children);
    assert.equal(tlv['26'].children['00'], 'CO.COM.RBM.LLA');
    assert.equal(tlv['26'].children['04'], '@jhon437203');
  });

  test('extrae el nombre del comercio (tag 59)', () => {
    const tlv = parseEmvco(QR_CUENTA);
    assert.equal(tlv['59'], 'Supermercado pa mi gen');
  });
});

describe('extractBrebKey', () => {
  test('QR con llave alfanumérica → @jhon437203', () => {
    const r = extractBrebKey(QR_LLAVE);
    assert.equal(r.key, '@jhon437203');
    assert.equal(r.keyType, 'alias');
    assert.equal(r.merchantName, '0'); // este QR trae "0" como nombre
  });

  test('QR por cuenta → identificador numérico + nombre comercio', () => {
    const r = extractBrebKey(QR_CUENTA);
    assert.equal(r.key, '0029353497');     // de la cuenta (tag 50.01)
    assert.equal(r.keyType, 'cuenta');
    assert.equal(r.merchantName, 'Supermercado pa mi gen');
  });

  test('string sin tag 26 → null', () => {
    assert.equal(extractBrebKey('00020101'), null);
  });
});

describe('decodeBrebString', () => {
  test('devuelve key + raw + tlv para regenerar', () => {
    const r = decodeBrebString(QR_LLAVE);
    assert.equal(r.key, '@jhon437203');
    assert.equal(r.raw, QR_LLAVE);
    assert.ok(r.tlv['26']);
  });

  test('string ilegible → null', () => {
    assert.equal(decodeBrebString('basura'), null);
  });
});
