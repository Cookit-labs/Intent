package server

import (
	"net/http"

	"github.com/Cookit-labs/intent/backend/internal/config"
	"github.com/gin-gonic/gin"
)

type Server struct {
	cfg    *config.Config
	router *gin.Engine
}

func New(cfg *config.Config) *Server {
	if cfg.Env == "production" {
		gin.SetMode(gin.ReleaseMode)
	}

	r := gin.New()

	// TODO: register middleware (logger, cors, auth, ratelimit, telemetry)
	r.Use(gin.Recovery())

	s := &Server{cfg: cfg, router: r}
	s.registerRoutes()
	return s
}

func (s *Server) Router() http.Handler {
	return s.router
}

func (s *Server) registerRoutes() {
	s.router.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "env": s.cfg.Env})
	})

	v1 := s.router.Group("/v1")

	// TODO: register all service handlers
	_ = v1
	// v1.POST("/intents", intentHandler.Create)
	// v1.GET("/intents", intentHandler.List)
	// v1.GET("/intents/:id", intentHandler.Get)
	// v1.GET("/competitions", competitionHandler.List)
	// v1.GET("/competitions/:id", competitionHandler.Get)
	// v1.GET("/agents", agentHandler.List)
	// v1.GET("/agents/:id", agentHandler.Get)
	// v1.GET("/leaderboard", leaderboardHandler.Get)
	// v1.GET("/ws", realtimeHandler.HandleWS)
}