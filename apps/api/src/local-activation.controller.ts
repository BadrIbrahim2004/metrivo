import {
  Body,
  Controller,
  Post,
  UseGuards,
} from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import { Public } from './authz.decorator'
import {
  RequestLocalActivationCodeDto,
  VerifyLocalActivationCodeDto,
} from './local-activation.dto'
import { LocalActivationService } from './local-activation.service'

@Controller('activation')
export class LocalActivationController {
  constructor(private readonly activation: LocalActivationService) {}

  @Public()
  @Post('request')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  requestCode(@Body() input: RequestLocalActivationCodeDto) {
    return this.activation.requestCode(input.deviceId)
  }

  @Public()
  @Post('verify')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verifyCode(@Body() input: VerifyLocalActivationCodeDto) {
    return this.activation.verifyCode(input.deviceId, input.code)
  }
}
