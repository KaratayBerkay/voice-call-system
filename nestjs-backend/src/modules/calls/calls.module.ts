import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { CallGateway } from './call.gateway';
import { CallService } from './call.service';

@Module({
  providers: [CallGateway, CallService, AuthService],
})
export class CallsModule {}
