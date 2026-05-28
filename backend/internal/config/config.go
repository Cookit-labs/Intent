package config

import (
	"github.com/spf13/viper"
)

type Config struct {
	Port        string `mapstructure:"PORT"`
	Env         string `mapstructure:"ENV"`
	LogLevel    string `mapstructure:"LOG_LEVEL"`
	DatabaseURL string `mapstructure:"DATABASE_URL"`
	RedisURL    string `mapstructure:"REDIS_URL"`
	JWTSecret   string `mapstructure:"JWT_SECRET"`
	JWTExpiry   string `mapstructure:"JWT_EXPIRY"`
	ArcRPCURL   string `mapstructure:"ARC_RPC_URL"`
	ArcChainID  int    `mapstructure:"ARC_CHAIN_ID"`
	OTELEndpoint string `mapstructure:"OTEL_ENDPOINT"`
}

func Load() (*Config, error) {
	viper.SetConfigFile(".env")
	viper.AutomaticEnv()
	_ = viper.ReadInConfig()

	viper.SetDefault("PORT", "8080")
	viper.SetDefault("ENV", "development")
	viper.SetDefault("LOG_LEVEL", "info")
	viper.SetDefault("JWT_EXPIRY", "24h")

	cfg := &Config{}
	if err := viper.Unmarshal(cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}