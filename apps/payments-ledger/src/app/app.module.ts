import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { LedgerModule } from '../application/ledger.module';

@Module({
  imports: [LedgerModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
