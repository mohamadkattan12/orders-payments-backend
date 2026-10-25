// Fictional store "Mithal Store". Names and prices are made up; prices include 15% VAT.

const SAR = (riyals: number) => riyals * 100;

export const PRODUCTS = [
  {
    sku: 'DATES-SUKKARI-1KG',
    nameAr: 'تمر سكري 1 كجم',
    nameEn: 'Sukkari dates 1 kg',
    priceHalalas: SAR(45),
    stock: 200,
  },
  {
    sku: 'COFFEE-SAUDI-500G',
    nameAr: 'قهوة سعودية 500 جم',
    nameEn: 'Saudi coffee 500 g',
    priceHalalas: SAR(65),
    stock: 120,
  },
  {
    sku: 'OUD-OIL-12ML',
    nameAr: 'دهن عود 12 مل',
    nameEn: 'Oud oil 12 ml',
    priceHalalas: SAR(350),
    stock: 5,
  },
  {
    sku: 'PRAYER-MAT',
    nameAr: 'سجادة صلاة',
    nameEn: 'Prayer mat',
    priceHalalas: SAR(89),
    stock: 60,
  },
  {
    sku: 'DALLAH-POT',
    nameAr: 'دلة قهوة',
    nameEn: 'Dallah coffee pot',
    priceHalalas: SAR(120),
    stock: 3,
  },
  {
    sku: 'TEA-CUPS-SET',
    nameAr: 'طقم بيالات',
    nameEn: 'Tea glasses set',
    priceHalalas: SAR(75),
    stock: 40,
  },
  {
    sku: 'INCENSE-BURNER',
    nameAr: 'مبخرة',
    nameEn: 'Incense burner',
    priceHalalas: SAR(99),
    stock: 25,
  },
  {
    sku: 'BAKHOOR-100G',
    nameAr: 'بخور 100 جم',
    nameEn: 'Bakhoor 100 g',
    priceHalalas: SAR(55),
    stock: 80,
  },
  {
    sku: 'SAFFRON-5G',
    nameAr: 'زعفران 5 جم',
    nameEn: 'Saffron 5 g',
    priceHalalas: 3999,
    stock: 150,
  },
  {
    sku: 'HONEY-SIDR-500G',
    nameAr: 'عسل سدر 500 جم',
    nameEn: 'Sidr honey 500 g',
    priceHalalas: SAR(180),
    stock: 2,
  },
  {
    sku: 'THOBE-WHITE',
    nameAr: 'ثوب أبيض',
    nameEn: 'White thobe',
    priceHalalas: SAR(160),
    stock: 30,
  },
  {
    sku: 'SHEMAGH-RED',
    nameAr: 'شماغ أحمر',
    nameEn: 'Red shemagh',
    priceHalalas: SAR(135),
    stock: 50,
  },
];
