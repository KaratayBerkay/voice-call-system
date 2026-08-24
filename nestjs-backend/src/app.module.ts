import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CallsModule } from './modules/calls/calls.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), CallsModule],
})
export class AppModule {}
