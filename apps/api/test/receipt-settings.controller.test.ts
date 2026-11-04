import 'reflect-metadata'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import {
  RequireAuthenticated,
  RequireTenantOwner,
  TENANT_OWNER_ONLY,
  AUTHENTICATED_ONLY,
} from '../src/authz.decorator'
import { ReceiptSettingsController } from '../src/receipt-settings.controller'
import { ReceiptSettingsDto } from '../src/receipt-settings.dto'
import type { ReceiptSettingsService } from '../src/receipt-settings.service'

describe('ReceiptSettingsController', () => {
  it('lets authenticated tenant members read receipt settings but reserves updates for the owner', () => {
    assert.equal(
      Reflect.getMetadata(
        AUTHENTICATED_ONLY,
        ReceiptSettingsController.prototype.get,
      ),
      true,
    )
    assert.equal(
      Reflect.getMetadata(
        TENANT_OWNER_ONLY,
        ReceiptSettingsController.prototype.update,
      ),
      true,
    )
    assert.equal(typeof RequireAuthenticated, 'function')
    assert.equal(typeof RequireTenantOwner, 'function')
  })

  it('validates optional receipt branding fields and rejects unsafe logo data URLs', () => {
    const valid = plainToInstance(ReceiptSettingsDto, {
      receiptDisplayName: 'Metrivo Cafe',
      receiptLogoDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      receiptPhone: '+201234567890',
      receiptAddress: 'Cairo',
      receiptFacebook: 'metrivo',
      receiptInstagram: '@metrivo',
      receiptTiktok: '@metrivo',
      receiptYoutube: 'https://youtube.com/@metrivo',
      receiptWhatsapp: '+201234567890',
      receiptX: '@metrivo',
      receiptTelegram: '@metrivo',
      receiptSnapchat: '@metrivo',
      receiptLinkedin: 'https://linkedin.com/company/metrivo',
      receiptWebsite: 'https://metrivo.example',
    })
    assert.deepEqual(validateSync(valid, {
      whitelist: true,
      forbidNonWhitelisted: true,
    }), [])

    const invalid = plainToInstance(ReceiptSettingsDto, {
      receiptLogoDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=',
    })
    assert.ok(validateSync(invalid).length > 0)
  })

  it('requires an authenticated principal when reading receipt settings', async () => {
    const controller = new ReceiptSettingsController({} as ReceiptSettingsService)
    assert.throws(
      () => controller.get('tenant-1', {}),
      /Authenticated user is required/,
    )
  })
})
