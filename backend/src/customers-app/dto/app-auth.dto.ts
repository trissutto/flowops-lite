import { IsString, IsOptional, MinLength, Matches } from 'class-validator';

/**
 * DTOs do auth do app cliente final (app.lurds.com.br).
 * Separado dos DTOs de auth de operador (que é por email).
 */

export class AppLoginDto {
  // CPF SÓ digits — frontend manda já limpo via cpfDigits()
  @IsString()
  @Matches(/^\d{11}$/, { message: 'CPF deve ter 11 dígitos' })
  cpf!: string;

  @IsString()
  @MinLength(6, { message: 'Senha deve ter pelo menos 6 caracteres' })
  password!: string;
}

export class AppRegisterDto {
  @IsString()
  @Matches(/^\d{11}$/, { message: 'CPF deve ter 11 dígitos' })
  cpf!: string;

  @IsString()
  @MinLength(3, { message: 'Nome muito curto' })
  name!: string;

  @IsString()
  @Matches(/^\d{10,11}$/, { message: 'Telefone deve ter 10 ou 11 dígitos (DDD + número)' })
  phone!: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsString()
  @MinLength(6, { message: 'Senha deve ter pelo menos 6 caracteres' })
  password!: string;
}

export class AppMarkPwaInstalledDto {
  // Nada — o token JWT já identifica o customer.
  // Mas reservado pra metadata futura (device, source).
  @IsOptional()
  @IsString()
  source?: string;
}
