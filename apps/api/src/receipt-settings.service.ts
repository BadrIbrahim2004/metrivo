import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { PrismaService } from './prisma.service'
import { ReceiptSettingsDto } from './receipt-settings.dto'

export interface ReceiptSettings {
  receiptDisplayName: string | null
  receiptLogoDataUrl: string | null
  receiptPhone: string | null
  receiptAddress: string | null
  receiptFacebook: string | null
  receiptInstagram: string | null
  receiptTiktok: string | null
  receiptYoutube: string | null
  receiptWhatsapp: string | null
  receiptX: string | null
  receiptTelegram: string | null
  receiptSnapchat: string | null
  receiptLinkedin: string | null
  receiptWebsite: string | null
}

export interface ReceiptSettingsResult extends ReceiptSettings {
  canManageReceiptSettings: boolean
}

@Injectable()
export class ReceiptSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getForUser(
    actorUserId: string,
    tenantId: string,
  ): Promise<ReceiptSettingsResult> {
    const rows = await this.prisma.$queryRaw<Array<
      ReceiptSettingsResult & { canAccessReceiptSettings: boolean }
    >>`
      SELECT t."receiptDisplayName", t."receiptLogoDataUrl",
             t."receiptPhone", t."receiptAddress",
             t."receiptFacebook", t."receiptInstagram",
             t."receiptTiktok", t."receiptYoutube",
             t."receiptWhatsapp", t."receiptX", t."receiptTelegram",
             t."receiptSnapchat", t."receiptLinkedin", t."receiptWebsite",
             EXISTS (
               SELECT 1 FROM "TenantMembership" tm
               JOIN "User" u
                 ON u.id = tm."userId"
                AND u.status = 'ACTIVE'
               WHERE tm."userId" = ${actorUserId}
                 AND tm."tenantId" = t.id
                 AND tm.status = 'ACTIVE'
             ) AS "canAccessReceiptSettings",
             EXISTS (
               SELECT 1
               FROM "TenantMembership" tm
               JOIN "User" u
                 ON u.id = tm."userId"
                AND u.status = 'ACTIVE'
               JOIN "MembershipRole" mr
                 ON mr."membershipId" = tm.id
                AND mr."tenantId" = tm."tenantId"
               JOIN "Role" r
                 ON r.id = mr."roleId"
                AND r."tenantId" = mr."tenantId"
               WHERE tm."userId" = ${actorUserId}
                 AND tm."tenantId" = t.id
                 AND tm.status = 'ACTIVE'
                 AND r.name = 'Owner'
             ) AS "canManageReceiptSettings"
      FROM "Tenant" t
      WHERE t.id = ${tenantId}
    `
    if (!rows[0]) throw new NotFoundException('Tenant not found')
    const { canAccessReceiptSettings, ...settings } = rows[0]
    if (!canAccessReceiptSettings) {
      throw new ForbiddenException('Active tenant membership required')
    }
    return settings
  }

  async update(
    tenantId: string,
    input: ReceiptSettingsDto,
  ): Promise<ReceiptSettings> {
    const logo = input.receiptLogoDataUrl?.trim() || null
    if (logo) this.validateLogo(logo)
    const displayName = this.normalize(input.receiptDisplayName)
    const phone = this.normalize(input.receiptPhone)
    const address = this.normalize(input.receiptAddress)
    const facebook = this.normalize(input.receiptFacebook)
    const instagram = this.normalize(input.receiptInstagram)
    const tiktok = this.normalize(input.receiptTiktok)
    const youtube = this.normalize(input.receiptYoutube)
    const whatsapp = this.normalize(input.receiptWhatsapp)
    const x = this.normalize(input.receiptX)
    const telegram = this.normalize(input.receiptTelegram)
    const snapchat = this.normalize(input.receiptSnapchat)
    const linkedin = this.normalize(input.receiptLinkedin)
    const website = this.normalize(input.receiptWebsite)

    const rows = await this.prisma.$queryRaw<ReceiptSettings[]>`
      UPDATE "Tenant"
      SET "receiptDisplayName" = ${displayName},
          "receiptLogoDataUrl" = ${logo},
          "receiptPhone" = ${phone},
          "receiptAddress" = ${address},
          "receiptFacebook" = ${facebook},
          "receiptInstagram" = ${instagram},
          "receiptTiktok" = ${tiktok},
          "receiptYoutube" = ${youtube},
          "receiptWhatsapp" = ${whatsapp},
          "receiptX" = ${x},
          "receiptTelegram" = ${telegram},
          "receiptSnapchat" = ${snapchat},
          "receiptLinkedin" = ${linkedin},
          "receiptWebsite" = ${website},
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${tenantId}
      RETURNING "receiptDisplayName", "receiptLogoDataUrl",
                "receiptPhone", "receiptAddress",
                "receiptFacebook", "receiptInstagram",
                "receiptTiktok", "receiptYoutube",
                "receiptWhatsapp", "receiptX", "receiptTelegram",
                "receiptSnapchat", "receiptLinkedin", "receiptWebsite"
    `
    if (!rows[0]) throw new NotFoundException('Tenant not found')
    return rows[0]
  }

  private normalize(value: string | null | undefined): string | null {
    return value?.trim() || null
  }

  private validateLogo(dataUrl: string): void {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      dataUrl,
    )
    if (!match) throw new BadRequestException('Invalid receipt logo')

    const encoded = match[2]
    const bytes = Buffer.from(encoded, 'base64')
    if (
      bytes.length === 0 ||
      bytes.length > 512 * 1024 ||
      bytes.toString('base64') !== encoded
    ) {
      throw new BadRequestException('Receipt logo must be at most 512 KB')
    }

    const mime = match[1]
    const validSignature =
      mime === 'png'
        ? bytes.length >= 8 &&
          bytes.subarray(0, 8).equals(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          )
        : mime === 'jpeg'
          ? bytes.length >= 3 &&
            bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
          : bytes.length >= 12 &&
            bytes.toString('ascii', 0, 4) === 'RIFF' &&
            bytes.toString('ascii', 8, 12) === 'WEBP'
    if (!validSignature) throw new BadRequestException('Invalid receipt logo image')
  }
}
